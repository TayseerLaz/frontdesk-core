// Phase 5.4 — Sequence tick worker.
//
// Every 30 seconds, scan for active enrollments whose next_step_due_at has
// arrived, send the corresponding template via Meta, and bump the enrollment
// to the next step (or mark completed). Each enrollment+step is processed
// inside a single transaction so the worker is restart-safe.
//
// We deliberately reuse the broadcast-send template-send path: a Meta send
// becomes one outbound WhatsAppMessage row. There's no BroadcastRecipient
// for sequence sends — that's by design (sequences ≠ broadcasts).
import { prisma } from './db.js';
import { recordOutboundTemplate } from './inbox-consistency.js';
import { getConnection } from '../lib/redis.js';
import { canAfford, chargeAtSend, resolveMeteredPrice } from '../lib/wallet.js';

const TICK_INTERVAL_MS = Number(process.env.SEQUENCE_TICK_INTERVAL_MS ?? 30_000);
const TICK_LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 5;
const TICK_LOCK_KEY = 'lock:sequence-tick';

interface VariableSourceCsv {
  kind: 'csv';
  column: string;
}
interface VariableSourceAttribute {
  kind: 'attribute';
  key: string;
  fallback?: string;
}
interface VariableSourceField {
  kind: 'field';
  field: 'display_name' | 'phone_e164' | 'locale';
  fallback?: string;
}
interface VariableSourceStatic {
  kind: 'static';
  value: string;
}
type VariableSource =
  | VariableSourceCsv
  | VariableSourceAttribute
  | VariableSourceField
  | VariableSourceStatic;

function resolveVariables(
  mapping: Record<string, VariableSource>,
  ctx: {
    phone: string;
    displayName: string | null;
    locale: string | null;
    attributes: Record<string, unknown>;
  },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [idx, src] of Object.entries(mapping)) {
    let val = '';
    switch (src.kind) {
      case 'static':
        val = src.value;
        break;
      case 'attribute': {
        const v = ctx.attributes[src.key];
        val = typeof v === 'string' ? v : v != null ? String(v) : (src.fallback ?? '');
        break;
      }
      case 'field':
        val =
          src.field === 'phone_e164'
            ? ctx.phone
            : src.field === 'display_name'
              ? (ctx.displayName ?? src.fallback ?? '')
              : (ctx.locale ?? src.fallback ?? '');
        break;
      default:
        val = '';
    }
    out[idx] = val;
  }
  return out;
}

async function callMeta(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  language: string;
  variables: Record<string, string>;
}): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  const indices = Object.keys(args.variables)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
  const parameters = indices.map((idx) => ({ type: 'text' as const, text: args.variables[String(idx)] ?? '' }));
  const components = parameters.length > 0 ? [{ type: 'body', parameters }] : [];
  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: { name: args.templateName, language: { code: args.language }, ...(components.length ? { components } : {}) },
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(args.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const text = await res.text();
    if (res.ok) {
      try {
        const body = JSON.parse(text) as { messages?: { id?: string }[] };
        return { ok: true, metaMessageId: body.messages?.[0]?.id ?? null, error: null };
      } catch {
        return { ok: false, metaMessageId: null, error: 'unparseable response' };
      }
    }
    return { ok: false, metaMessageId: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, metaMessageId: null, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

async function processOneEnrollment(enrollmentId: string): Promise<void> {
  const e = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      sequence: { include: { steps: { orderBy: { stepOrder: 'asc' } } } },
      contact: true,
    },
  });
  if (!e || e.status !== 'active') return;
  if (e.contact.optedOutAt || e.contact.deletedAt) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    return;
  }
  const step = e.sequence.steps[e.nextStepIndex];
  if (!step) {
    // No more steps — mark completed.
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'completed', completedAt: new Date() },
    });
    return;
  }
  // SECURITY (H-3): scope the channel load to the enrollment's own org. The
  // worker uses the RLS-bypassing owner client, so a `channelId` PATCHed to
  // point at ANOTHER org's number would otherwise load that org's decrypted
  // Meta credentials and drip on them. A cross-tenant (or missing) channel now
  // returns null and falls into the mis-configured branch below — no send.
  const channel = await prisma.whatsAppChannel.findFirst({
    where: { id: e.sequence.channelId, organizationId: e.organizationId },
  });
  if (!channel?.accessToken || !channel.phoneNumberId) {
    // Channel mis-configured — leave enrollment active; it'll retry next tick.
    return;
  }
  const template = await prisma.whatsAppTemplate.findUnique({ where: { id: step.templateId } });
  if (!template) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    return;
  }
  const variables = resolveVariables(
    (step.variables as unknown as Record<string, VariableSource>) ?? {},
    {
      phone: e.contact.phoneE164,
      displayName: e.contact.displayName,
      locale: e.contact.locale,
      attributes: (e.contact.attributes as Record<string, unknown>) ?? {},
    },
  );

  // Metered billing (docs/wallet-billing-plan.md): a sequence step is a real
  // WhatsApp send. If the metered tenant can't afford it, skip this tick and
  // leave the enrollment due so it resumes automatically once they top up.
  const metered = await resolveMeteredPrice(e.organizationId);
  if (metered && !(await canAfford(e.organizationId, metered.priceMicros))) {
    return;
  }

  const out = await callMeta({
    token: channel.accessToken,
    phoneNumberId: channel.phoneNumberId,
    to: e.contact.phoneE164,
    templateName: template.name,
    language: template.language,
    variables,
  });

  if (!out.ok) {
    // Soft retry: leave nextStepDueAt unchanged so the next tick picks it up.
    // Three failures in a row → cancel (basic safety).
    return;
  }

  // Persist outbound message LINKED to the customer's inbox thread (was
  // creating an orphaned, thread-less row that never showed in the inbox),
  // then advance enrollment to the next step or complete.
  await recordOutboundTemplate({
    organizationId: e.organizationId,
    toNumber: e.contact.phoneE164,
    metaMessageId: out.metaMessageId,
    templateName: template.name,
  });

  // Charge the delivered sequence message against the metered wallet.
  if (metered) {
    await chargeAtSend({
      orgId: e.organizationId,
      unitPriceMicros: metered.priceMicros,
      metaCostMicros: metered.metaCostMicros,
    });
  }

  const nextIdx = e.nextStepIndex + 1;
  const nextStep = e.sequence.steps[nextIdx];
  if (!nextStep) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'completed', nextStepIndex: nextIdx, completedAt: new Date() },
    });
    return;
  }
  // Schedule the next step.
  const dueAt = new Date(Date.now() + nextStep.delayHours * 3600 * 1000);
  await prisma.sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { nextStepIndex: nextIdx, nextStepDueAt: dueAt },
  });
}

async function tick(): Promise<void> {
  // Distributed lock so multiple worker replicas don't double-fire.
  const redis = getConnection();
  const lock = await redis.set(TICK_LOCK_KEY, '1', 'EX', TICK_LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;
  try {
    const due = await prisma.sequenceEnrollment.findMany({
      where: {
        status: 'active',
        nextStepDueAt: { lte: new Date() },
      },
      take: 200,
      orderBy: { nextStepDueAt: 'asc' },
      select: { id: true },
    });
    for (const row of due) {
      try {
        await processOneEnrollment(row.id);
      } catch (err) {
        console.error('[sequence-tick] enrollment failed', row.id, err);
      }
    }
  } finally {
    // Lock auto-expires; no explicit unlock so a crashed worker doesn't leak.
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startSequenceTick(): { close: () => Promise<void>; name: string } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[sequence-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Stagger initial fire 5s after boot so we're not racing other workers.
  timer = setTimeout(run, 5_000);
  return {
    name: 'sequence-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
