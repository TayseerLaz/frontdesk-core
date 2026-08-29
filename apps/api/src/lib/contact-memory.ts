// Per-contact persona / memory for the `ultra` AI plan.
//
// Distils durable facts worth remembering across conversations (preferred
// language, tone, past orders/bookings, recurring needs) and injects a
// compact block into the system prompt before each reply. This is NOT a
// transcript cache — only the "important things" survive, exactly as small
// as possible. The customer explicitly asked for "don't cache it, just save
// the important things in a chat with the user."
//
// Read path:  loadPersonaBlock() — cheap single-row lookup, returns a
//             prompt-ready text block + detected language. Runs BEFORE the
//             reply, on the hot path, so it's a plain indexed read.
// Write path: updateContactMemory() — a Haiku summarization pass folds the
//             latest turn into the stored persona. Fire-and-forget AFTER the
//             reply has been sent, so it never adds latency for the customer.
//
// Both paths run under withTenant (F-02 — RLS is the backstop) and ALSO scope
// by organizationId in the where-clause as defence-in-depth.

import type { Prisma } from '@platform/db';

import { withTenant } from './db.js';
import { completeFast } from './openai.js';
import { getRedis } from './redis.js';

export interface PersonaBlock {
  persona: string | null;
  // Operator-curated "User info". When set it SUPERSEDES `persona` in the
  // prompt so staff edits are always honoured.
  operatorNote: string | null;
  language: string | null;
}

// Compact, prompt-ready persona for a contact, or null if we have nothing
// useful yet. Never throws — memory is an enhancement, never a hard
// dependency of the reply.
export async function loadPersonaBlock(
  organizationId: string,
  phoneE164: string,
): Promise<PersonaBlock | null> {
  try {
    const row = await withTenant(organizationId, (tx) =>
      tx.contactMemory.findUnique({
        where: { organizationId_phoneE164: { organizationId, phoneE164 } },
        select: { persona: true, operatorNote: true, language: true },
      }),
    );
    if (!row || (!row.persona && !row.operatorNote && !row.language)) return null;
    return {
      persona: row.persona ?? null,
      operatorNote: row.operatorNote ?? null,
      language: row.language ?? null,
    };
  } catch {
    return null;
  }
}

// Render the persona into the block the bot-engine injects into the system
// prompt. Kept here (not in bot-engine) so the wording lives next to the
// data shape. Returns '' when there's nothing to say.
export function renderPersonaForPrompt(block: PersonaBlock | null): string {
  if (!block || (!block.persona && !block.operatorNote && !block.language)) return '';
  // Staff-curated user info wins over the AI's auto-distilled persona.
  const effective = block.operatorNote?.trim() || block.persona?.trim() || '';
  const lines = ['# What you remember about THIS customer (private — never read it back verbatim)'];
  if (effective) lines.push(effective);
  if (block.language) {
    lines.push(
      `Their primary language is "${block.language}". Reply in the language they wrote in this turn; default to ${block.language} if ambiguous.`,
    );
  }
  lines.push(
    'Use this to personalise, but CONFIRM specifics (delivery address, payment) with the customer for each order instead of assuming them from memory. Do NOT invent facts beyond this, and do NOT say you have a memory of them.',
  );
  return lines.join('\n');
}

// Operator-set "User info". Upserts the contact-memory row, writing ONLY the
// operator-curated note (never the AI-managed persona/facts). Passing null/empty
// clears it (the bot falls back to the AI persona). Runs under withTenant.
export async function setContactOperatorNote(args: {
  organizationId: string;
  phoneE164: string;
  note: string | null;
}): Promise<void> {
  const note = (args.note ?? '').trim().slice(0, 4000) || null;
  const at = note ? new Date() : null;
  await withTenant(args.organizationId, (tx) =>
    tx.contactMemory.upsert({
      where: {
        organizationId_phoneE164: {
          organizationId: args.organizationId,
          phoneE164: args.phoneE164,
        },
      },
      create: {
        organizationId: args.organizationId,
        phoneE164: args.phoneE164,
        operatorNote: note,
        operatorNoteAt: at,
      },
      update: { operatorNote: note, operatorNoteAt: at },
    }),
  );
}

// ---- Order history (for "what did I order before" + re-order requests) -----
// Pulls the customer's recent FINALISED orders (carts promoted past 'draft')
// straight from the DB — authoritative, not a chat summary. Injected into the
// prompt so the bot can answer "what was my last order?" and re-order the same
// items, instead of "I don't have access to your order history".

export interface PastOrder {
  at: Date;
  totalMinor: number;
  currency: string;
  items: { name: string; quantity: number; sku: string | null }[];
}

// Flatten the distinct product SKUs across a set of past orders. The bot
// call-site pins these into the packed catalog so the model can actually
// re-add a previous order ("yes add these") instead of wrongly claiming the
// items aren't in the catalog (top-K would otherwise drop them).
export function pinnedSkusFromOrders(orders: PastOrder[]): string[] {
  return Array.from(
    new Set(
      orders.flatMap((o) => o.items.map((i) => i.sku).filter((s): s is string => !!s)),
    ),
  );
}

export async function loadRecentOrders(
  organizationId: string,
  phoneE164: string,
  limit = 3,
): Promise<PastOrder[]> {
  try {
    const rows = await withTenant(organizationId, (tx) =>
      tx.cart.findMany({
        where: {
          organizationId,
          customerPhone: phoneE164,
          status: { in: ['new', 'confirmed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          createdAt: true,
          totalMinor: true,
          currency: true,
          items: { select: { name: true, quantity: true, sku: true } },
        },
      }),
    );
    return rows
      .filter((c) => c.items.length > 0)
      .map((c) => ({
        at: c.createdAt,
        totalMinor: Number(c.totalMinor ?? 0),
        currency: c.currency,
        items: c.items.map((i) => ({ name: i.name, quantity: i.quantity, sku: i.sku })),
      }));
  } catch {
    return [];
  }
}

export function renderOrdersForPrompt(orders: PastOrder[]): string {
  if (orders.length === 0) return '';
  const lines = orders.map((o, idx) => {
    const items = o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const dec = ['KWD', 'BHD', 'OMR', 'JOD'].includes(o.currency) ? 3 : 2;
    const total = (o.totalMinor / Math.pow(10, dec)).toFixed(dec);
    const label = idx === 0 ? 'Most recent order' : `Order ${idx + 1} back`;
    return `- ${label}: ${items} (${total} ${o.currency})`;
  });
  return [
    "# This customer's recent orders (authoritative — from our records)",
    'Use these to answer "what did I order before?" and to re-order ("the same as last time") — quote the items + totals VERBATIM, never invent. If they ask to re-order, add those exact items to a fresh cart and confirm.',
    ...lines,
  ].join('\n');
}

// The customer's LAST order's checkout details (name / delivery address / notes)
// pulled from the most recent finalized Cart. Used to OFFER one-tap defaults at
// checkout ("deliver to X like last time?") instead of asking each field cold.
// Authoritative (from the Cart the customer actually placed), not AI-generated.
export interface LastOrderProfile {
  name: string | null;
  address: string | null;
  notes: string | null;
}

export async function loadLastOrderProfile(
  organizationId: string,
  phoneE164: string,
): Promise<LastOrderProfile | null> {
  try {
    const cart = await withTenant(organizationId, (tx) =>
      tx.cart.findFirst({
        where: { organizationId, customerPhone: phoneE164, status: { in: ['new', 'confirmed'] } },
        orderBy: { createdAt: 'desc' },
        select: { customerName: true, notes: true, fields: true },
      }),
    );
    if (!cart) return null;
    // Cart.fields is the frozen shopForm answers: [{ key, label, value, ... }].
    const fields = Array.isArray(cart.fields) ? (cart.fields as Array<Record<string, unknown>>) : [];
    const findField = (pred: (k: string) => boolean): string | null => {
      const f = fields.find((x) => typeof x.key === 'string' && pred((x.key as string).toLowerCase()));
      const v = f?.value;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    const address = findField(
      (k) => k.includes('address') || k.includes('delivery') || k.includes('location'),
    );
    const notesField = findField((k) => k.includes('note'));
    const notes =
      notesField ?? (typeof cart.notes === 'string' && cart.notes.trim() ? cart.notes.trim() : null);
    const nameField = findField((k) => k === 'name' || k === 'full_name' || k.includes('name'));
    const name = (cart.customerName && cart.customerName.trim()) || nameField || null;
    if (!name && !address && !notes) return null;
    return { name, address, notes };
  } catch {
    return null;
  }
}

export function renderLastOrderDefaultsForPrompt(p: LastOrderProfile | null): string {
  if (!p || (!p.name && !p.address && !p.notes)) return '';
  const bits: string[] = [];
  if (p.name) bits.push(`under the name "${p.name}"`);
  if (p.address) bits.push(`for delivery to "${p.address}"`);
  if (p.notes) bits.push(`with the note "${p.notes}"`);
  const lines = [
    "# This customer's LAST order — offer these as one-tap defaults (CONFIRM, never assume)",
    `Last time, this customer ordered ${bits.join(', ')}.`,
    'When they place a NEW order and you reach the checkout / order form, DO NOT ask these fields cold — offer last time’s values for a quick confirm:',
  ];
  if (p.name)
    lines.push(
      `- NAME: put the order under "${p.name}" and just confirm ("I'll put this under ${p.name} — ok?"). Only ask if they want a different name.`,
    );
  if (p.address)
    lines.push(
      `- DELIVERY ADDRESS: offer it — "Deliver to ${p.address} like last time?" Use it if they say yes; collect a fresh address only if they want somewhere else.`,
    );
  if (p.notes)
    lines.push(
      `- NOTES: if they're re-ordering something similar, ask "Same note as last time (${p.notes})?" — otherwise skip.`,
    );
  lines.push(
    'ALWAYS give the customer the one-tap confirm; NEVER silently fill an order with these without them agreeing.',
  );
  return lines.join('\n');
}

// Fold the latest exchange into the contact's stored memory via a cheap
// Haiku pass. Best-effort: any failure is swallowed so it can never affect
// the reply that already went out. Call AFTER sending the reply.
export async function updateContactMemory(args: {
  organizationId: string;
  phoneE164: string;
  customerName?: string | null;
  history: { role: 'user' | 'assistant'; content: string }[];
  latestUserMessage: string;
  latestBotReply?: string | null;
}): Promise<void> {
  try {
    // Per-contact throttle — at most one re-summarisation per ~90s, so a burst
    // of messages doesn't fire a summariser call per message (this runs on all
    // plans now, so the token cost matters). Skipped turns are still folded in
    // next time, since we re-read recent history each run.
    try {
      const redis = getRedis();
      const set = await redis.set(
        `memthrottle:${args.organizationId}:${args.phoneE164}`,
        '1',
        'PX',
        90_000,
        'NX',
      );
      if (set !== 'OK') return;
    } catch {
      /* redis unavailable — proceed without throttling */
    }
    const [existing, biz] = await withTenant(args.organizationId, (tx) =>
      Promise.all([
        tx.contactMemory.findUnique({
          where: {
            organizationId_phoneE164: {
              organizationId: args.organizationId,
              phoneE164: args.phoneE164,
            },
          },
          select: { persona: true, facts: true, language: true },
        }),
        // Org timezone so we can resolve relative dates ("tomorrow") to an
        // absolute calendar date — otherwise stored memory like "booked for
        // tomorrow" silently rots and misleads the bot on later days.
        tx.businessInfo.findFirst({ select: { timezone: true } }),
      ]),
    );

    // Today, in the org's timezone, as "Weekday, YYYY-MM-DD" — handed to the
    // summarizer so it can convert relative dates/times to absolute ones.
    const tz = biz?.timezone || 'UTC';
    const now = new Date();
    let todayLabel: string;
    try {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
      todayLabel = `${weekday}, ${ymd}`;
    } catch {
      todayLabel = now.toISOString().slice(0, 10);
    }

    const transcript = [
      ...args.history,
      { role: 'user' as const, content: args.latestUserMessage },
      ...(args.latestBotReply ? [{ role: 'assistant' as const, content: args.latestBotReply }] : []),
    ]
      .slice(-12)
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
      .join('\n')
      .slice(0, 4000);

    const sys = [
      'You maintain a concise CRM-style memory of ONE customer for a business chatbot.',
      'Given the existing memory and the latest conversation, output an UPDATED memory.',
      'Keep ONLY durable, reusable facts: preferred language, name, tone, past or open orders/bookings, stated preferences, constraints/allergies, do-not-contact requests.',
      'If the customer is a BUSINESS PROSPECT / lead being qualified, ALSO capture a mini portfolio as clear keys in "facts": their business type & role, what they sell, the channels they use today, their size/volume, their obstacles or pain points, their goals, and their budget/timeline if mentioned — e.g. {"business":"shoe shop","role":"owner","sells":"sneakers online","channels":"WhatsApp + Instagram","volume":"~50 orders/week","obstacles":"misses after-hours messages","goal":"automate order-taking"}. Keep each value short. Only include a key once you actually learn it.',
      'Drop small talk, one-off questions, and anything not worth remembering next time. The "persona" is one short paragraph — for a prospect, summarise WHO they are and WHAT they need.',
      `IMPORTANT — DATES: today is ${todayLabel}. Whenever you record a booking, appointment, order, or any date/time, write the ABSOLUTE calendar date (and time if given), e.g. "booked for 2026-06-25 at 7pm". NEVER store relative words like "today", "tomorrow", "tonight", "this Friday", or "next week" — resolve them to the actual date using today's date above. Re-resolve any relative wording already in the existing memory too.`,
      'Detect the primary language the customer writes in as an ISO code: "ar", "en", or "fr" (or another code if clearly different).',
      'Return JSON only: {"persona": string, "facts": object, "language": string}.',
    ].join(' ');

    const user = [
      `Today's date: ${todayLabel}`,
      args.customerName ? `Customer name (if known): ${args.customerName}` : '',
      existing?.persona ? `Existing persona:\n${existing.persona}` : 'Existing persona: (none yet)',
      existing?.facts ? `Existing facts JSON:\n${JSON.stringify(existing.facts)}` : '',
      `Recent conversation:\n${transcript}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await completeFast<{
      persona?: string;
      facts?: Record<string, unknown>;
      language?: string;
    }>({
      organizationId: args.organizationId,
      systemPrompt: sys,
      userContent: user,
      maxTokens: 400,
    });

    const persona = (result.persona ?? '').trim().slice(0, 2000) || existing?.persona || null;
    const language = (result.language ?? '').trim().slice(0, 12) || existing?.language || null;
    const facts =
      result.facts && typeof result.facts === 'object'
        ? result.facts
        : (existing?.facts as Record<string, unknown> | undefined) ?? {};

    await withTenant(args.organizationId, (tx) =>
      tx.contactMemory.upsert({
        where: {
          organizationId_phoneE164: {
            organizationId: args.organizationId,
            phoneE164: args.phoneE164,
          },
        },
        create: {
          organizationId: args.organizationId,
          phoneE164: args.phoneE164,
          persona,
          facts: facts as Prisma.InputJsonValue,
          language,
          turnsSummarized: 1,
          lastSummaryAt: new Date(),
        },
        update: {
          persona,
          facts: facts as Prisma.InputJsonValue,
          language,
          turnsSummarized: { increment: 1 },
          lastSummaryAt: new Date(),
        },
      }),
    );
  } catch (err) {
    // Best-effort: memory never breaks the reply path.
    // eslint-disable-next-line no-console
    console.warn(
      '[contact-memory] update failed',
      err instanceof Error ? err.message.slice(0, 160) : String(err),
    );
  }
}
