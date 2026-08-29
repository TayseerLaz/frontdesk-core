// ALIGNED HQ admin copilot.
//
// A streaming chat assistant for ALIGNED super-admins only. It knows how the
// platform works (the system prompt below) AND can pull LIVE tenant data via
// tool calls (tenants, a tenant's catalog, quotas, platform totals). The route
// streams the final answer token-by-token. Admin-only — never exposed to tenants.
import OpenAI from 'openai';

import { withRlsBypass } from './db.js';
import { env } from './env.js';
import { getOrgQuotas } from './billing.js';

let _client: OpenAI | null = null;
function oa(): OpenAI {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  return (_client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY }));
}

// gpt-4o for the copilot — this is an internal, low-volume admin tool where
// answer quality matters more than per-token cost.
const MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `You are "Hader Copilot", the AI assistant for ALIGNED HQ super-admins inside the Hader (formerly ALIGNED) platform — a multi-tenant WhatsApp/Messenger/Instagram + phone AI customer-service & commerce platform.

WHO YOU HELP: ALIGNED staff/admins (not tenants). You answer ANYTHING they ask: how the platform works, how to operate it, tenant questions ("how many products does Booty Republic have?"), troubleshooting, support, billing/quotas, and product/feature explanations.

WHAT THE PLATFORM DOES (so you can explain it):
- Each tenant = an "organization". Tenants manage a catalog (products, services, categories), business info (hours, locations, contacts, FAQs, policies), and connect channels: WhatsApp (Meta Cloud API, one or more numbers), Facebook Messenger, Instagram DMs, and phone (voicebot). An LLM bot answers inbound messages grounded in that tenant's data — taking orders (cart/shop flow), bookings, escalating to humans, sending images/voice.
- AI tiers (Organization.aiPlan): basic (Groq Llama 3.3 70B + GPT-4o-mini fallback), middle (GPT-4o), max/ultra (Claude — ultra adds per-customer persona memory). This is the model tier, separate from the subscription plan.
- Subscription plans (free/starter/growth/enterprise) set quota CAPS: monthly messages, monthly broadcasts, monthly imports, products, services, members, API keys, webhooks. Usage shows as a percentage of cap; tenants get notified at 75/80/85/90/95/100%.
- Per-tenant feature access (Organization.disabledFeatures): ai, catalog, orders (cart), bookings, messenger, instagram, phone, exports, analytics, inbox, broadcasts, contacts. ALIGNED admin toggles these per tenant (Tenants → Access).
- Other features: broadcasts (campaigns), contacts CRM with AI-written + operator-editable "User info", segments, sequences, data export (CSV zip), outbound webhooks, API connectors, API keys, audit log, message provenance/hallucination audit (admin), notifications.
- Admin powers (the /hq area): list/suspend/reactivate/delete tenants, create tenants, control (impersonate) a workspace, change AI tier + subscription plan, set disabled features, view AI usage (tokens + USD) and quotas (%), export any tenant's data, leads, system health, cross-tenant provenance.

USING TOOLS: For anything tenant-specific or numeric (counts, quotas, which tenants, a tenant's products/services, platform totals), CALL THE TOOLS to get live data — never guess numbers. Resolve a tenant by name, slug, or id. If a tool returns nothing, say so plainly.

STYLE: Professional, concise, and clear. Use short paragraphs and markdown (bold, bullet lists, small tables) when it helps. Lead with the answer. When you cite numbers, they must come from a tool result. If something is outside the platform (e.g. a Meta dashboard step), explain it briefly and say where it lives. Never invent tenant data, prices, or capabilities that don't exist.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_tenants',
      description:
        'List tenants (organizations) with status, AI tier, and member/product/service counts. Use for "how many tenants", "which tenants", or searching by name/slug.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional name/slug search.' },
          status: { type: 'string', enum: ['active', 'suspended', 'deleted'] },
          limit: { type: 'integer', description: 'Max rows (default 50).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tenant',
      description:
        "Full detail for ONE tenant by name, slug, or id: status, AI tier, subscription plan, disabled features, counts, quotas (usage vs cap with %), and WhatsApp number.",
      parameters: {
        type: 'object',
        properties: { tenant: { type: 'string', description: 'name, slug, or id' } },
        required: ['tenant'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tenant_catalog',
      description: "List a tenant's products or services (name, price, availability).",
      parameters: {
        type: 'object',
        properties: {
          tenant: { type: 'string' },
          kind: { type: 'string', enum: ['products', 'services'] },
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Max rows (default 25).' },
        },
        required: ['tenant', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'platform_stats',
      description:
        'Platform-wide totals: tenant counts by status and totals of products, services, members, contacts, and WhatsApp numbers.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function resolveOrg(ref: string) {
  const r = ref.trim();
  return withRlsBypass(async (tx) => {
    if (isUuid(r)) {
      const byId = await tx.organization.findUnique({ where: { id: r } });
      if (byId) return byId;
    }
    const bySlug = await tx.organization.findFirst({ where: { slug: r.toLowerCase() } });
    if (bySlug) return bySlug;
    return tx.organization.findFirst({ where: { name: { contains: r, mode: 'insensitive' } } });
  });
}

async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'list_tenants') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const status = typeof args.status === 'string' ? args.status : undefined;
    const limit = Math.min(Number(args.limit) || 50, 100);
    return withRlsBypass(async (tx) => {
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (query)
        where.OR = [
          { name: { contains: query, mode: 'insensitive' } },
          { slug: { contains: query.toLowerCase() } },
        ];
      const orgs = await tx.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, slug: true, name: true, status: true, aiPlan: true, disabledFeatures: true },
      });
      const rows = await Promise.all(
        orgs.map(async (o) => {
          const [members, products, services] = await Promise.all([
            tx.membership.count({ where: { organizationId: o.id, isActive: true } }),
            tx.product.count({ where: { organizationId: o.id, deletedAt: null } }),
            tx.service.count({ where: { organizationId: o.id, deletedAt: null } }),
          ]);
          return { ...o, members, products, services };
        }),
      );
      return { count: rows.length, tenants: rows };
    });
  }

  if (name === 'get_tenant') {
    const org = await resolveOrg(String(args.tenant ?? ''));
    if (!org) return { error: 'No tenant matched that name/slug/id.' };
    return withRlsBypass(async (tx) => {
      const [members, products, services, apiKeys, webhooks, wa, quotas] = await Promise.all([
        tx.membership.count({ where: { organizationId: org.id, isActive: true } }),
        tx.product.count({ where: { organizationId: org.id, deletedAt: null } }),
        tx.service.count({ where: { organizationId: org.id, deletedAt: null } }),
        tx.apiKey.count({ where: { organizationId: org.id, revokedAt: null } }),
        tx.webhookEndpoint.count({ where: { organizationId: org.id } }),
        tx.whatsAppChannel.findFirst({
          where: { organizationId: org.id, isPrimary: true },
          select: { displayPhoneNumber: true, isActive: true, botEnabled: true, lastVerifyStatus: true },
        }),
        getOrgQuotas(tx as never, org.id),
      ]);
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        aiTier: org.aiPlan,
        subscriptionPlan: quotas.planCode,
        disabledFeatures: org.disabledFeatures,
        counts: { members, products, services, apiKeys, webhooks },
        whatsapp: wa,
        quotas: quotas.quotas,
      };
    });
  }

  if (name === 'list_tenant_catalog') {
    const org = await resolveOrg(String(args.tenant ?? ''));
    if (!org) return { error: 'No tenant matched that name/slug/id.' };
    const kind = args.kind === 'services' ? 'services' : 'products';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(Number(args.limit) || 25, 60);
    return withRlsBypass(async (tx) => {
      if (kind === 'services') {
        const rows = await tx.service.findMany({
          where: {
            organizationId: org.id,
            deletedAt: null,
            ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
          },
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: { name: true, basePriceMinor: true, currency: true, isAvailable: true },
        });
        return { tenant: org.name, kind, count: rows.length, items: rows };
      }
      const rows = await tx.product.findMany({
        where: {
          organizationId: org.id,
          deletedAt: null,
          ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { name: true, sku: true, priceMinor: true, currency: true, isAvailable: true },
      });
      return { tenant: org.name, kind, count: rows.length, items: rows };
    });
  }

  if (name === 'platform_stats') {
    return withRlsBypass(async (tx) => {
      const [active, suspended, deleted, products, services, members, contacts, waNumbers] =
        await Promise.all([
          tx.organization.count({ where: { status: 'active' } }),
          tx.organization.count({ where: { status: 'suspended' } }),
          tx.organization.count({ where: { status: 'deleted' } }),
          tx.product.count({ where: { deletedAt: null } }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.membership.count({ where: { isActive: true } }),
          tx.contact.count({ where: { deletedAt: null } }),
          tx.whatsAppChannel.count(),
        ]);
      return {
        tenants: { active, suspended, deleted, total: active + suspended + deleted },
        totals: { products, services, members, contacts, whatsappNumbers: waNumbers },
      };
    });
  }

  return { error: `Unknown tool: ${name}` };
}

export interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Run the copilot: resolve any tool calls, then stream the final answer.
// Yields text deltas for the route to flush to the client.
export async function* runAdminCopilot(history: CopilotMessage[]): AsyncGenerator<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Tool-resolution loop (no streaming) — bounded so a tool loop can't run away.
  for (let round = 0; round < 4; round++) {
    const resp = await oa().chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
    });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    if (!msg.tool_calls?.length) break; // ready to answer
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      let result: unknown;
      try {
        result = await execTool(tc.function.name, parsed);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'tool failed' };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 14000),
      });
    }
  }

  // Final answer — streamed token by token (no tools so it must produce text).
  const stream = await oa().chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.3,
    stream: true,
  });
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export function isCopilotConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}
