// Phase 2 — AI bot builder routes.
//
// Surfaces:
//   - POST /bot/analyze         start website crawl + LLM analysis (queues a CrawlJob)
//   - GET  /bot/analyze/:id     status of a crawl job + page count
//   - GET  /bot/knowledge-base  list KB entries (manual + AI, all kinds)
//   - PATCH/DELETE/POST on /bot/knowledge-base/:id/...
//   - GET  /bot/config          current BotConfig (creates a stub on first call)
//   - PUT  /bot/config          update personality / greeting / flow / templates
//   - GET  /bot/questionnaire   AI-generated 5–10 questions to fill the gaps
//   - POST /bot/simulate        live preview turn — uses bot-engine
//   - POST /bot/scenarios/run   runs the 5 canonical test scenarios + LLM-as-judge
//   - GET  /bot/scenarios/last  last results
//   - POST /bot/deploy          flips deployedAt on BotConfig
//   - POST /bot/undeploy        clears deployedAt (rollback)
import {
  ApiErrorCode,
  followUpsConfigSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  normalizeFollowUpsConfig,
  successSchema,
  uuidSchema,
  type FollowUpsConfig,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { complete, isOpenAIConfigured } from '../../lib/openai.js';
import { recordAudit } from '../../lib/audit.js';
import { buildBotResponse, gatherBotData } from '../../lib/bot-engine.js';
import { parseCustomButtons } from '../../lib/quick-buttons.js';
import { withTenant } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getCrawlQueue } from '../../lib/queues.js';
import { resolveAssetUrl } from '../catalog/shared.js';

// ----- DTO schemas (registered for Swagger; keep flat) -----

const botConfigDto = z.object({
  id: uuidSchema,
  personality: z.string().nullable(),
  customPersonality: z.string().nullable(),
  detectedTone: z.string().nullable(),
  greeting: z.string().nullable(),
  // When true, the bot's first reply in a thread opens with the
  // customer's WhatsApp profile name. Off by default.
  greetByName: z.boolean(),
  quickRepliesEnabled: z.boolean(),
  // F11 — operator-configured quick buttons (max 3). `always` buttons are
  // merged into every AI reply; a tap on a label with replyText answers
  // deterministically without the LLM.
  customButtons: z
    .array(z.object({ label: z.string(), replyText: z.string().nullable(), always: z.boolean() }))
    .nullable(),
  languages: z.string(),
  escalationRules: z.record(z.string(), z.unknown()).nullable(),
  conversationFlow: z.record(z.string(), z.unknown()).nullable(),
  responseTemplates: z.record(z.string(), z.unknown()).nullable(),
  deployedAt: z.string().datetime().nullable(),
  // Phase 6 — voice replies. ttsProvider picks Google or ElevenLabs;
  // ttsVoiceName carries the provider-appropriate identifier (voice
  // NAME for Google, voice ID for ElevenLabs).
  replyMode: z.enum(['text', 'voice', 'match_customer']),
  ttsProvider: z.enum(['google', 'elevenlabs']),
  ttsVoiceName: z.string().nullable(),
  // Wasabi storage key for the greeting image (banner / welcome graphic).
  // Bot attaches it alongside greeting replies; null = no image.
  greetingImageStorageKey: z.string().nullable(),
  // Wasabi storage key for the greeting voice note (intro audio). Sent with the
  // greeting / the scripted flow's entry node; null = no voice.
  greetingVoiceStorageKey: z.string().nullable(),
  // Deterministic scripted flow (guided button-driven intake). Editable from the
  // bot builder. Null = pure LLM bot.
  scriptedFlow: z.record(z.string(), z.unknown()).nullable(),
  // Automated follow-ups config (no-reply / post-booking / idle check-in).
  // Shape = followUpsConfigSchema; null = never configured.
  followUps: z.record(z.string(), z.unknown()).nullable(),
  // F2 — post-conversation feedback config ({enabled}); null = never set.
  feedback: z.record(z.string(), z.unknown()).nullable(),
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Counts surfaced alongside every crawl-job status payload so the bot
// page can render a live "X products · Y FAQs · Z contacts" line that
// ticks up as the worker walks the site. Products are filtered to the
// rows this crawl produced (attributes.crawlJobId match); the others
// are org-wide totals because the inline business-content extractor
// upserts rather than tagging, and watching the total tick is enough
// signal for the operator that something IS being extracted.
async function buildCrawlLiveCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  crawlJobId: string,
): Promise<{
  products: number;
  productsPending: number;
  faqs: number;
  contacts: number;
  locations: number;
  policies: number;
  hasAbout: boolean;
}> {
  const [products, productsPending, faqs, contacts, locations, policies, businessInfo] = await Promise.all([
    tx.product.count({
      where: {
        deletedAt: null,
        attributes: { path: ['crawlJobId'], equals: crawlJobId },
      },
    }),
    tx.product.count({
      where: {
        deletedAt: null,
        isAvailable: false,
        attributes: { path: ['crawlJobId'], equals: crawlJobId },
      },
    }),
    tx.fAQ.count(),
    tx.contactChannel.count(),
    tx.location.count(),
    tx.policy.count(),
    tx.businessInfo.findFirst({ select: { about: true } }),
  ]);
  return {
    products,
    productsPending,
    faqs,
    contacts,
    locations,
    policies,
    hasAbout: !!(businessInfo?.about && businessInfo.about.trim()),
  };
}

const crawlJobDto = z.object({
  id: uuidSchema,
  rootUrl: z.string(),
  status: z.string(),
  pagesCrawled: z.number().int(),
  pagesFailed: z.number().int(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // Snapshot of how much the inline per-page extractors have written
  // into the tenant's catalog so far. Lets the bot page show live
  // ticking counts as the crawl walks the site instead of leaving
  // every counter at zero until the BFS finishes.
  liveCounts: z
    .object({
      products: z.number().int(),
      productsPending: z.number().int(),
      faqs: z.number().int(),
      contacts: z.number().int(),
      locations: z.number().int(),
      policies: z.number().int(),
      hasAbout: z.boolean(),
    })
    .optional(),
});

const kbEntryDto = z.object({
  id: uuidSchema,
  kind: z.string(),
  question: z.string(),
  answer: z.string(),
  sourceUrl: z.string().nullable(),
  sourceType: z.string(),
  approved: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Fallback scenarios — used only when LLM generation fails AND the org has
// no manual scenarios saved. Kept tiny + generic so an admin sees SOMETHING
// when they click "Run all" on a fresh org.
const FALLBACK_SCENARIOS: { key: string; prompt: string; expectation: string }[] = [
  {
    key: 'unknown_question',
    prompt: 'Do you ship to Antarctica?',
    expectation:
      'Bot says it does not have that information and offers to escalate to a human. No fabrication.',
  },
];

// Generate fresh test scenarios from the org's CURRENT knowledge base + catalog.
// Returns 5–8 scenarios as `{ key, prompt, expectation }`. Each scenario tests
// a specific KB topic the operator should care about — menu lookups, hours,
// allergens, delivery, refunds, etc.
async function generateScenariosFromKb(
  orgId: string,
  data: Awaited<ReturnType<typeof gatherBotData>>,
): Promise<{ key: string; prompt: string; expectation: string }[]> {
  // Compress the KB / catalog / business info into a tight prompt context.
  const kbSnippets = data.kb.slice(0, 30).map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const productSnippets = data.products
    .slice(0, 20)
    .map((p) => `- ${p.name}${p.shortDescription ? ` (${p.shortDescription})` : ''}`)
    .join('\n');
  const serviceSnippets = data.services
    .slice(0, 10)
    .map((s) => `- ${s.name}${s.shortDescription ? ` (${s.shortDescription})` : ''}`)
    .join('\n');
  const bizContext = data.biz
    ? `Business: ${data.biz.legalName ?? ''}\nTagline: ${data.biz.tagline ?? ''}\nAbout: ${(data.biz.about ?? '').slice(0, 400)}`
    : '';

  // Make sure cart + booking flows get test coverage when they're
  // enabled. Without this nudge the LLM defaults to "what time do you
  // open?"-style scenarios and never exercises the load-bearing
  // [CART:] / [BOOKING:] markers.
  const flowsEnabled: string[] = [];
  if (data.shopForm?.enabled) {
    flowsEnabled.push(
      `- SHOP / CART flow is enabled. Include scenarios that exercise it: (a) a happy-path single-item order, (b) a multi-item order with delivery address + payment method, (c) at least one edge case (below-minimum order, an item NOT in catalog, change-of-mind mid-cart). The bot should refuse off-catalog items and emit a [CART: ...] marker on confirmation — write expectations that check for those.`,
    );
  }
  if (data.bookingForm?.enabled) {
    flowsEnabled.push(
      `- BOOKING flow is enabled (title: "${data.bookingForm.title}"). Include scenarios that exercise booking: (a) a happy-path booking, (b) a booking with vague time the bot must clarify. Expectations should check the bot collects every required field + emits a [BOOKING: ...] marker on confirmation.`,
    );
  }
  const flowsContext =
    flowsEnabled.length > 0
      ? `\n\nACTIVE FLOWS — must be exercised in the scenarios:\n${flowsEnabled.join('\n')}`
      : '';

  const sys =
    'You are a QA test designer for customer-support chatbots. Generate REALISTIC test scenarios a customer of THIS specific business might ask. Cover a spread: product/service lookups, hours, delivery, allergens or policies, edge cases the bot might get wrong, and at least one out-of-scope question. Return STRICT JSON only (no prose, no markdown): {"scenarios": [{"key": "<slug>", "prompt": "<customer message>", "expectation": "<one-sentence pass criterion for an LLM judge>"}]}. 6–8 scenarios, keys are short snake_case slugs, prompts are colloquial first-person customer messages.';
  const user = `${bizContext}\n\nKnowledge base:\n${kbSnippets || '(empty)'}\n\nProducts:\n${productSnippets || '(none)'}\n\nServices:\n${serviceSnippets || '(none)'}${flowsContext}`;

  try {
    const out = await complete({
      organizationId: orgId,
      systemPrompt: sys,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1400,
      temperature: 0.4,
    });
    const trimmed = out.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed) as {
      scenarios?: { key?: unknown; prompt?: unknown; expectation?: unknown }[];
    };
    if (!Array.isArray(parsed.scenarios)) return FALLBACK_SCENARIOS;
    const seen = new Set<string>();
    const cleaned: { key: string; prompt: string; expectation: string }[] = [];
    for (const s of parsed.scenarios) {
      const key = typeof s.key === 'string'
        ? s.key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
        : '';
      const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
      const expectation = typeof s.expectation === 'string' ? s.expectation.trim() : '';
      if (!key || !prompt || !expectation || seen.has(key)) continue;
      seen.add(key);
      cleaned.push({ key, prompt, expectation });
      if (cleaned.length >= 10) break;
    }
    return cleaned.length > 0 ? cleaned : FALLBACK_SCENARIOS;
  } catch {
    return FALLBACK_SCENARIOS;
  }
}

// Generate 3–5 conversation-flow CANDIDATES tailored to the business.
// Each candidate is a complete `{ nodes: [{ intent, label, response }] }`
// shape the bot-engine already consumes. The LLM picks ONE as
// `isRecommended = true` and justifies why with `recommendReason`.
async function generateFlowCandidates(
  orgId: string,
  data: Awaited<ReturnType<typeof gatherBotData>>,
): Promise<
  {
    name: string;
    description: string;
    flow: { nodes: { intent: string; label: string; response: string }[] };
    isRecommended: boolean;
    recommendReason: string | null;
  }[]
> {
  const kbSnippets = data.kb.slice(0, 25).map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const productNames = data.products.slice(0, 25).map((p) => p.name).join(', ');
  const serviceNames = data.services.slice(0, 15).map((s) => s.name).join(', ');
  const bizContext = data.biz
    ? `Business: ${data.biz.legalName ?? ''}\nTagline: ${data.biz.tagline ?? ''}\nAbout: ${(data.biz.about ?? '').slice(0, 400)}`
    : '';
  const policiesContext = data.policies
    .slice(0, 8)
    .map((p) => `- ${p.title} (${p.kind})`)
    .join('\n');

  // Flow recommender has to know which operator flows are enabled so
  // its candidates actually include the right intents (cart / order
  // intents when shop is on, booking intents when booking is on). It
  // also biases isRecommended toward the candidate that matches the
  // strongest signal.
  const enabledFlows: string[] = [];
  if (data.shopForm?.enabled) {
    enabledFlows.push(
      `- SHOP / CART flow is enabled (title: "${data.shopForm.title}"). Customers can place multi-item orders. EVERY candidate's intent nodes should include order-related intents: menu_lookup, add_to_cart, modify_cart, confirm_order, delivery_info, payment_method, order_status. The "Quick Order First" / "Self-Serve Menu" / "Concierge Sales" archetypes fit this profile best.`,
    );
  }
  if (data.bookingForm?.enabled) {
    enabledFlows.push(
      `- BOOKING flow is enabled (title: "${data.bookingForm.title}"). EVERY candidate's intent nodes should include booking-related intents: book_appointment, ask_availability, reschedule, cancel_booking. "Hospitality Concierge" / "Support-First" archetypes fit best.`,
    );
  }
  if (enabledFlows.length === 0) {
    enabledFlows.push(
      `- Neither shop nor booking is enabled. Focus on FAQ-style intents: greeting, product_info, hours, location, contact, escalation.`,
    );
  }
  const flowsContext = `\n\nACTIVE OPERATOR FLOWS:\n${enabledFlows.join('\n')}`;

  const sys =
    'You are a senior conversation designer. Look at the business and produce 3–5 DIFFERENT conversation-flow CANDIDATES the operator can pick from. Each candidate represents a strategically different way of talking to customers (e.g. "Quick Order First", "Hospitality Concierge", "Support-First", "Concierge Sales", "Self-Serve Menu"). For EACH candidate, also produce 6–10 intent nodes — each intent has a slug like "menu_lookup", a human label, and a SHORT response template (1–3 sentences, in English, that the LLM-driven bot would adapt at runtime). The intent SET for every candidate MUST include the intents listed under ACTIVE OPERATOR FLOWS (operator has enabled these and the bot must support them). Mark exactly ONE candidate as "isRecommended" with a one-sentence "recommendReason" explaining why it fits this business best — bias toward an archetype that matches the active flow. Return STRICT JSON only: {"candidates": [{"name": "...", "description": "...", "isRecommended": true|false, "recommendReason": "..." | null, "nodes": [{"intent": "...", "label": "...", "response": "..."}]}]}. No prose, no markdown.';
  const user = `${bizContext}\n\nProducts: ${productNames || '(none)'}\nServices: ${serviceNames || '(none)'}\n\nKnowledge base highlights:\n${kbSnippets || '(empty)'}\n\nPolicies:\n${policiesContext || '(none)'}${flowsContext}`;

  try {
    const out = await complete({
      organizationId: orgId,
      systemPrompt: sys,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      temperature: 0.6,
    });
    const trimmed = out.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed) as {
      candidates?: {
        name?: unknown;
        description?: unknown;
        isRecommended?: unknown;
        recommendReason?: unknown;
        nodes?: { intent?: unknown; label?: unknown; response?: unknown }[];
      }[];
    };
    if (!Array.isArray(parsed.candidates)) return [];
    const cleaned = parsed.candidates
      .map((c) => {
        const name = typeof c.name === 'string' ? c.name.trim().slice(0, 80) : '';
        const description = typeof c.description === 'string' ? c.description.trim().slice(0, 400) : '';
        const recommendReason =
          typeof c.recommendReason === 'string' ? c.recommendReason.trim().slice(0, 300) : null;
        const isRecommended = c.isRecommended === true;
        const nodes = (Array.isArray(c.nodes) ? c.nodes : [])
          .map((n) => ({
            intent:
              typeof n.intent === 'string'
                ? n.intent.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
                : '',
            label: typeof n.label === 'string' ? n.label.trim().slice(0, 80) : '',
            response: typeof n.response === 'string' ? n.response.trim().slice(0, 600) : '',
          }))
          .filter((n) => n.intent && n.label && n.response);
        return { name, description, recommendReason, isRecommended, flow: { nodes } };
      })
      .filter((c) => c.name && c.description && c.flow.nodes.length > 0)
      .slice(0, 5);

    // Ensure exactly one candidate is recommended. If LLM didn't mark any,
    // pick the first; if it marked several, keep only the first one's flag.
    let recommendedSeen = false;
    for (const c of cleaned) {
      if (c.isRecommended && !recommendedSeen) {
        recommendedSeen = true;
      } else if (c.isRecommended) {
        c.isRecommended = false;
      }
    }
    if (!recommendedSeen && cleaned.length > 0) cleaned[0]!.isRecommended = true;
    return cleaned;
  } catch {
    return [];
  }
}

function serializeConfig(c: {
  id: string;
  personality: string | null;
  customPersonality: string | null;
  detectedTone: string | null;
  greeting: string | null;
  greetByName?: boolean | null;
  quickRepliesEnabled?: boolean | null;
  customButtons?: unknown;
  languages: string;
  escalationRules: unknown;
  conversationFlow: unknown;
  responseTemplates: unknown;
  deployedAt: Date | null;
  replyMode?: string;
  ttsProvider?: string | null;
  ttsVoiceName?: string | null;
  greetingImageStorageKey?: string | null;
  greetingVoiceStorageKey?: string | null;
  scriptedFlow?: unknown;
  followUps?: unknown;
  feedback?: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  // Coerce replyMode to the enum the DTO promises — defaults to 'text'
  // if anything else slipped in (no-op on fresh rows).
  const mode = (c.replyMode ?? 'text') as 'text' | 'voice' | 'match_customer';
  return {
    id: c.id,
    personality: c.personality,
    customPersonality: c.customPersonality,
    detectedTone: c.detectedTone,
    greeting: c.greeting,
    greetByName: Boolean(c.greetByName),
    quickRepliesEnabled: c.quickRepliesEnabled !== false,
    // Normalized through the same defensive parser the engine uses, so the
    // UI always sees exactly what the bot will act on.
    customButtons: c.customButtons == null ? null : parseCustomButtons(c.customButtons),
    languages: c.languages,
    escalationRules: (c.escalationRules ?? null) as Record<string, unknown> | null,
    conversationFlow: (c.conversationFlow ?? null) as Record<string, unknown> | null,
    responseTemplates: (c.responseTemplates ?? null) as Record<string, unknown> | null,
    deployedAt: c.deployedAt?.toISOString() ?? null,
    replyMode: ['text', 'voice', 'match_customer'].includes(mode) ? mode : 'text',
    ttsProvider: ((c.ttsProvider ?? 'google') === 'elevenlabs' ? 'elevenlabs' : 'google') as
      | 'google'
      | 'elevenlabs',
    ttsVoiceName: c.ttsVoiceName ?? null,
    greetingImageStorageKey: c.greetingImageStorageKey ?? null,
    greetingVoiceStorageKey: c.greetingVoiceStorageKey ?? null,
    scriptedFlow:
      c.scriptedFlow && typeof c.scriptedFlow === 'object'
        ? (c.scriptedFlow as Record<string, unknown>)
        : null,
    followUps:
      c.followUps && typeof c.followUps === 'object'
        ? (c.followUps as Record<string, unknown>)
        : null,
    feedback:
      c.feedback && typeof c.feedback === 'object'
        ? (c.feedback as Record<string, unknown>)
        : null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// The server owns followUps.enabledAt: stamped once on the off→on transition,
// preserved while it stays on, cleared when it turns off. The worker tick's
// eligibility never reaches behind this stamp, so a tenant enabling the
// feature can never trigger a blast over historical threads — which is why a
// client-sent enabledAt must never be trusted.
function stampFollowUpsEnabledAt(
  prevRaw: unknown,
  next: FollowUpsConfig | null,
): FollowUpsConfig | null {
  if (next === null) return null;
  const prev = normalizeFollowUpsConfig(prevRaw);
  const carriedStamp = prev?.enabled && prev.enabledAt ? prev.enabledAt : null;
  return {
    ...next,
    enabledAt: next.enabled ? (carriedStamp ?? new Date().toISOString()) : null,
  };
}

export default async function botRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /bot/config ----------
  r.get(
    '/bot/config',
    {
      schema: { tags: ['bot'], summary: 'Get the org bot config (auto-creates a stub).', response: { 200: itemEnvelopeSchema(botConfigDto) } },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!row) row = await tx.botConfig.create({ data: { organizationId: orgId } });
        return { data: serializeConfig(row) };
      });
    },
  );

  // ---------- GET /bot/voice-status ----------
  // One-shot voice-reply diagnostic. Surfaces the exact reason voice
  // mode did or didn't engage on the last few inbound messages, plus
  // whether the TTS providers are actually configured at the env
  // level. Admin-only; cheap; safe to leave in place as a long-term
  // troubleshooting tool.
  r.get(
    '/bot/voice-status',
    {
      schema: {
        tags: ['bot'],
        summary: 'Diagnose why voice replies are / are not firing.',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { isGoogleTtsConfigured } = await import('../../lib/tts-google.js');
      const { isElevenLabsConfigured } = await import('../../lib/tts-elevenlabs.js');
      return app.tenant(req, async (tx) => {
        const cfg = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        // Last 10 inbound voice/audio messages — confirms inbound type
        // is being detected as audio (which is what triggers
        // match_customer voice mode on the bot side).
        const recentInbound = await tx.whatsAppMessage.findMany({
          where: { organizationId: orgId, direction: 'inbound' },
          orderBy: { receivedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            receivedAt: true,
            messageType: true,
            fromNumber: true,
          },
        });
        // For each of those, also peek at the very next outbound reply
        // so we can see whether the bot answered with text or audio.
        const audited = await Promise.all(
          recentInbound.map(async (inb) => {
            const reply = await tx.whatsAppMessage.findFirst({
              where: {
                organizationId: orgId,
                direction: 'outbound',
                receivedAt: { gt: inb.receivedAt },
                rawPayload: { path: ['sentBy'], equals: 'bot' },
              },
              orderBy: { receivedAt: 'asc' },
              select: { messageType: true, receivedAt: true },
            });
            return {
              inboundAt: inb.receivedAt.toISOString(),
              inboundType: inb.messageType,
              from: inb.fromNumber,
              botReplyType: reply?.messageType ?? null,
              botRepliedAt: reply?.receivedAt?.toISOString() ?? null,
            };
          }),
        );
        const replyMode = (cfg?.replyMode as string | null) ?? 'text';
        const ttsProvider = (cfg?.ttsProvider as string | null) ?? 'google';
        const providerConfigured =
          ttsProvider === 'elevenlabs'
            ? isElevenLabsConfigured()
            : isGoogleTtsConfigured();
        // Build an actionable diagnosis sentence so the operator can
        // act without reading the raw object.
        const audioInbounds = audited.filter(
          (a) => a.inboundType === 'audio' || a.inboundType === 'voice',
        );
        const audioRepliedAsText = audioInbounds.filter(
          (a) => a.botReplyType && a.botReplyType !== 'audio',
        );
        let diagnosis: string;
        if (replyMode === 'text') {
          diagnosis =
            'replyMode is "text" — the bot ALWAYS sends text regardless of inbound type. Switch to "match_customer" or "voice" on /bot to get voice replies.';
        } else if (!providerConfigured) {
          diagnosis =
            `replyMode is "${replyMode}" but the ${ttsProvider} TTS provider is not configured. ` +
            (ttsProvider === 'elevenlabs'
              ? 'Set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID secrets in GitHub Actions and redeploy.'
              : 'Set GOOGLE_TTS_API_KEY secret in GitHub Actions and redeploy.');
        } else if (replyMode === 'match_customer' && audioInbounds.length === 0) {
          diagnosis =
            'replyMode is "match_customer" and TTS is configured, but none of the last 10 inbound messages were audio. The bot only speaks back when the customer speaks first. Send a voice note and retry.';
        } else if (replyMode === 'match_customer' && audioRepliedAsText.length > 0) {
          diagnosis =
            'TTS is configured + customer sent audio + replyMode is "match_customer" — but the bot replied as text. Likely the TTS call or transcode failed at runtime. Check journalctl -u platform-api | grep -E "TTS|wantsVoice".';
        } else {
          diagnosis = 'Voice path looks healthy. Send another voice note and check the result.';
        }
        return {
          data: {
            diagnosis,
            config: {
              replyMode,
              ttsProvider,
              ttsVoiceName: cfg?.ttsVoiceName ?? null,
              deployed: cfg?.deployedAt != null,
            },
            providerConfigured,
            googleTtsConfigured: isGoogleTtsConfigured(),
            elevenLabsConfigured: isElevenLabsConfigured(),
            recentMessages: audited,
            summary: {
              recentInboundAudio: audioInbounds.length,
              audioRepliedAsText: audioRepliedAsText.length,
            },
          },
        };
      });
    },
  );

  // ---------- PUT /bot/config ----------
  r.put(
    '/bot/config',
    {
      schema: {
        tags: ['bot'],
        summary: 'Update the bot config. Bumps version on every save.',
        body: z.object({
          personality: z.string().trim().max(40).nullable().optional(),
          customPersonality: z.string().trim().max(2000).nullable().optional(),
          greeting: z.string().trim().max(2000).nullable().optional(),
          greetByName: z.boolean().optional(),
          quickRepliesEnabled: z.boolean().optional(),
          // F11 — configured quick buttons. `null` clears. WhatsApp caps
          // interactive button titles at 20 chars, hence the label max.
          customButtons: z
            .array(
              z.object({
                label: z.string().trim().min(1).max(20),
                replyText: z.string().trim().max(4000).nullable().optional(),
                always: z.boolean().default(false),
              }),
            )
            .max(3)
            .nullable()
            .optional(),
          languages: z.string().trim().max(120).optional(),
          escalationRules: z.record(z.string(), z.unknown()).nullable().optional(),
          conversationFlow: z.record(z.string(), z.unknown()).nullable().optional(),
          responseTemplates: z.record(z.string(), z.unknown()).nullable().optional(),
          // Phase 6 — voice replies.
          replyMode: z.enum(['text', 'voice', 'match_customer']).optional(),
          ttsProvider: z.enum(['google', 'elevenlabs']).optional(),
          ttsVoiceName: z.string().trim().max(100).nullable().optional(),
          // Greeting image — Wasabi storage key (returned by the same
          // /assets/presign-put flow product images use). `null` clears.
          greetingImageStorageKey: z.string().trim().max(500).nullable().optional(),
          // Greeting voice note — Wasabi storage key (audio). `null` clears.
          greetingVoiceStorageKey: z.string().trim().max(500).nullable().optional(),
          // Full scripted-flow definition (edited in the bot builder). `null` clears.
          scriptedFlow: z.record(z.string(), z.unknown()).nullable().optional(),
          // Follow-ups config. Validated against the shared schema; the
          // server owns `enabledAt` (stamped on the off→on transition) — any
          // client-sent value is overwritten. `null` clears.
          followUps: followUpsConfigSchema.nullable().optional(),
          // F2 — post-conversation feedback toggle. `null` clears.
          feedback: z.object({ enabled: z.boolean() }).nullable().optional(),
        }),
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.botConfig.findUnique({ where: { organizationId: orgId } })) ??
          (await tx.botConfig.create({ data: { organizationId: orgId } }));
        const updated = await tx.botConfig.update({
          where: { id: existing.id },
          data: {
            personality: req.body.personality ?? undefined,
            customPersonality:
              req.body.customPersonality === undefined ? undefined : req.body.customPersonality,
            greeting: req.body.greeting === undefined ? undefined : req.body.greeting,
            greetByName: req.body.greetByName ?? undefined,
            quickRepliesEnabled: req.body.quickRepliesEnabled ?? undefined,
            customButtons:
              req.body.customButtons === undefined
                ? undefined
                : (req.body.customButtons as never),
            languages: req.body.languages ?? undefined,
            escalationRules: (req.body.escalationRules ?? undefined) as never,
            conversationFlow: (req.body.conversationFlow ?? undefined) as never,
            responseTemplates: (req.body.responseTemplates ?? undefined) as never,
            replyMode: req.body.replyMode ?? undefined,
            ttsProvider: req.body.ttsProvider ?? undefined,
            ttsVoiceName:
              req.body.ttsVoiceName === undefined ? undefined : req.body.ttsVoiceName,
            greetingImageStorageKey:
              req.body.greetingImageStorageKey === undefined
                ? undefined
                : req.body.greetingImageStorageKey,
            greetingVoiceStorageKey:
              req.body.greetingVoiceStorageKey === undefined
                ? undefined
                : req.body.greetingVoiceStorageKey,
            scriptedFlow:
              req.body.scriptedFlow === undefined ? undefined : (req.body.scriptedFlow as never),
            followUps:
              req.body.followUps === undefined
                ? undefined
                : (stampFollowUpsEnabledAt(existing.followUps, req.body.followUps) as never),
            feedback:
              req.body.feedback === undefined ? undefined : (req.body.feedback as never),
            version: { increment: 1 },
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_config',
          entityId: updated.id,
          metadata: { event: 'bot_config_updated', version: updated.version },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );

  // ---------- POST /bot/analyze ----------
  r.post(
    '/bot/analyze',
    {
      schema: {
        tags: ['bot'],
        summary: 'Start a website crawl + LLM analysis.',
        body: z.object({
          rootUrl: z.string().url(),
          // Deliberately generous caps so the crawler can cover an
          // entire mid-sized marketing site (root + nested sub-pages)
          // rather than just the home. 500 pages × 5 s timeout each
          // ≈ 40 min wall-clock worst case, which is acceptable for a
          // one-off setup task.
          maxPages: z.number().int().min(1).max(500).default(200),
          maxDepth: z.number().int().min(0).max(8).default(6),
        }),
        response: { 201: itemEnvelopeSchema(crawlJobDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const job = await app.tenant(req, (tx) =>
        tx.crawlJob.create({
          data: {
            organizationId: orgId,
            rootUrl: req.body.rootUrl,
            maxPages: req.body.maxPages,
            maxDepth: req.body.maxDepth,
            status: 'pending',
          },
        }),
      );
      await getCrawlQueue().add(
        'crawl',
        { organizationId: orgId, crawlJobId: job.id },
        {
          jobId: job.id,
          // attempts: 3 — without retries, a worker SIGTERM mid-crawl
          // (every deploy, every OOM, every container restart) PERMANENTLY
          // abandons the job and leaves the DB row stuck at status='running'
          // with no worker processing it. The retry doesn't fully resume
          // BFS (state is in-memory) but it re-runs the job-handler which
          // seeds its `seen` set from existing crawl_pages so most of the
          // first attempt's progress isn't wasted.
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 },
        },
      );
      reply.code(201);
      return {
        data: {
          id: job.id,
          rootUrl: job.rootUrl,
          status: job.status,
          pagesCrawled: 0,
          pagesFailed: 0,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdAt: job.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- GET /bot/analyze/latest ----------
  // The /bot page calls this on mount so it can pick up an already-
  // running crawl after the operator navigated away and back. Returns
  // the most recently created crawl job for the active org, regardless
  // of status — the client only restores the activeJobId for pending /
  // running rows.
  r.get(
    '/bot/analyze/latest',
    {
      schema: {
        tags: ['bot'],
        summary: 'Most recent crawl job for the active org (any status). data:null if none.',
        // Returns { data: null } (200) rather than 404 when the org has never
        // run a website analysis — the /bot page polls this on mount, and a 404
        // would spam the browser console on every normal first-time visit.
        response: { 200: itemEnvelopeSchema(crawlJobDto.nullable()) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findFirst({
          orderBy: { createdAt: 'desc' },
        });
        if (!job) return { data: null };
        const liveCounts = await buildCrawlLiveCounts(tx, job.id);
        return {
          data: {
            id: job.id,
            rootUrl: job.rootUrl,
            status: job.status,
            pagesCrawled: job.pagesCrawled,
            pagesFailed: job.pagesFailed,
            errorMessage: job.errorMessage,
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
            createdAt: job.createdAt.toISOString(),
            liveCounts,
          },
        };
      }),
  );

  // ---------- POST /bot/analyze/:id/cancel ----------
  // Operator-initiated stop. We only flip the row status — the worker
  // polls it at each page boundary and exits cleanly. Idempotent: a
  // second cancel on an already-terminal job is a no-op.
  r.post(
    '/bot/analyze/:id/cancel',
    {
      schema: {
        tags: ['bot'],
        summary: 'Request cancellation of a running crawl. Worker checks between pages.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(crawlJobDto) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        // Only running / pending jobs need to be cancelled. Anything
        // terminal is left alone so the UI shows the real outcome.
        const isLive = job.status === 'pending' || job.status === 'running';
        const updated = isLive
          ? await tx.crawlJob.update({
              where: { id: job.id },
              data: { status: 'cancelled' },
            })
          : job;
        const liveCounts = await buildCrawlLiveCounts(tx, updated.id);
        return {
          data: {
            id: updated.id,
            rootUrl: updated.rootUrl,
            status: updated.status,
            pagesCrawled: updated.pagesCrawled,
            pagesFailed: updated.pagesFailed,
            errorMessage: updated.errorMessage,
            startedAt: updated.startedAt?.toISOString() ?? null,
            finishedAt: updated.finishedAt?.toISOString() ?? null,
            createdAt: updated.createdAt.toISOString(),
            liveCounts,
          },
        };
      }),
  );

  // ---------- GET /bot/analyze/:id ----------
  r.get(
    '/bot/analyze/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Crawl job status.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(crawlJobDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        const liveCounts = await buildCrawlLiveCounts(tx, job.id);
        return {
          data: {
            id: job.id,
            rootUrl: job.rootUrl,
            status: job.status,
            pagesCrawled: job.pagesCrawled,
            pagesFailed: job.pagesFailed,
            errorMessage: job.errorMessage,
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
            createdAt: job.createdAt.toISOString(),
            liveCounts,
          },
        };
      }),
  );

  // ---------- GET /bot/analyze/:id/pages ----------
  // The actual list of pages this crawl visited — URL, title, fetch
  // status, the size of the extracted body text, plus a short preview.
  // Operators use this to verify the crawler actually got real content
  // (e.g. SPA sites that return the same skeleton HTML for every URL
  // would show identical body_text + identical chars across all rows).
  r.get(
    '/bot/analyze/:id/pages',
    {
      schema: {
        tags: ['bot'],
        summary: 'List the pages a crawl job touched (URL + extracted text preview).',
        params: z.object({ id: uuidSchema }),
        response: {
          200: listEnvelopeSchema(
            z.object({
              id: uuidSchema,
              url: z.string(),
              title: z.string().nullable(),
              fetchStatus: z.number().int().nullable(),
              chars: z.number().int().nonnegative(),
              errorMessage: z.string().nullable(),
              bodyPreview: z.string(),
              identicalToFirst: z.boolean(),
              createdAt: z.string().datetime(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        const pages = await tx.crawlPage.findMany({
          where: { crawlJobId: job.id },
          orderBy: { createdAt: 'asc' },
        });
        // Flag pages whose body text matches the FIRST crawled page's body
        // text exactly — a strong "this is an SPA, we got nothing" signal.
        // Compares the trimmed prose only so trailing whitespace doesn't
        // hide a real-but-identical render.
        const firstBody = pages[0]?.bodyText?.trim() ?? '';
        const data = pages.map((p) => ({
          id: p.id,
          url: p.url,
          title: p.title,
          fetchStatus: p.fetchStatus,
          chars: (p.bodyText ?? '').length,
          errorMessage: p.errorMessage,
          // 500-char preview is enough to see what the LLM saw without
          // pulling 100 KB of HTML over the wire on every page load.
          bodyPreview: (p.bodyText ?? '').slice(0, 500),
          identicalToFirst:
            !!firstBody && p.bodyText !== null && p.bodyText.trim() === firstBody,
          createdAt: p.createdAt.toISOString(),
        }));
        return { data, nextCursor: null };
      }),
  );

  // ---------- GET /bot/analyze/:id/listings -------------------------------
  // Products this crawl job created (as DRAFTs with isAvailable=false).
  // The /bot page polls this so the operator sees each listing materialise
  // live while the LLM extraction is still iterating page-by-page. Includes
  // the bare-minimum fields the review card needs — name, price, short
  // description, source URL, status — to keep the response small.
  r.get(
    '/bot/analyze/:id/listings',
    {
      schema: {
        tags: ['bot'],
        summary: 'List draft products created by this crawl job for operator review.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: listEnvelopeSchema(
            z.object({
              id: uuidSchema,
              name: z.string(),
              sku: z.string(),
              priceMinor: z.number().int().nullable(),
              currency: z.string(),
              shortDescription: z.string().nullable(),
              description: z.string().nullable(),
              isAvailable: z.boolean(),
              sourceUrl: z.string().nullable(),
              primaryImageUrl: z.string().nullable(),
              createdAt: z.string().datetime(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        const rows = await tx.product.findMany({
          where: {
            deletedAt: null,
            // Match products whose attributes.crawlJobId == this job. Postgres
            // JSONB equality is fine because the worker writes the id as a
            // string in the same encoding the query emits.
            attributes: { path: ['crawlJobId'], equals: job.id },
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
          include: {
            images: { take: 1, orderBy: { sortOrder: 'asc' }, include: { asset: true } },
          },
        });
        const data = await Promise.all(
          rows.map(async (p) => {
            const attrs = (p.attributes as Record<string, unknown> | null) ?? {};
            const sourceUrl =
              typeof attrs.sourceUrl === 'string' ? (attrs.sourceUrl as string) : null;
            return {
              id: p.id,
              name: p.name,
              sku: p.sku,
              priceMinor: p.priceMinor,
              currency: p.currency,
              shortDescription: p.shortDescription,
              description: p.description,
              isAvailable: p.isAvailable,
              sourceUrl,
              primaryImageUrl: p.images[0]
                ? await resolveAssetUrl(p.images[0].asset.storageKey)
                : null,
              createdAt: p.createdAt.toISOString(),
            };
          }),
        );
        return { data, nextCursor: null };
      }),
  );

  // ---------- POST /bot/analyze/:id/listings/approve-all ------------------
  // Publishes EVERY remaining draft from this crawl in one round trip. Skips
  // anything the operator already touched (isAvailable=true OR an attribute
  // mutation that broke the `source==='crawl'` invariant) so we never
  // overwrite a manual edit. Returns the publish count for the UI toast.
  r.post(
    '/bot/analyze/:id/listings/approve-all',
    {
      schema: {
        tags: ['bot'],
        summary: 'Publish every remaining draft listing from this crawl (isAvailable=true).',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ approved: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        const result = await tx.product.updateMany({
          where: {
            deletedAt: null,
            isAvailable: false,
            attributes: { path: ['crawlJobId'], equals: job.id },
          },
          data: { isAvailable: true },
        });
        return { data: { approved: result.count } };
      }),
  );

  // ---------- POST /bot/analyze/:id/listings/deny-all ---------------------
  // Soft-delete every remaining draft from this crawl. Like approve-all,
  // skips published rows so an operator's "this one is good" survives.
  r.post(
    '/bot/analyze/:id/listings/deny-all',
    {
      schema: {
        tags: ['bot'],
        summary: 'Soft-delete every remaining draft listing from this crawl.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ denied: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        const result = await tx.product.updateMany({
          where: {
            deletedAt: null,
            isAvailable: false,
            attributes: { path: ['crawlJobId'], equals: job.id },
          },
          data: { deletedAt: new Date() },
        });
        return { data: { denied: result.count } };
      }),
  );

  // ---------- POST /bot/analyze/:id/listings/:productId/approve -----------
  // Per-row approve. Equivalent to PATCH /products/:id isAvailable=true but
  // namespaced under the crawl so the UI doesn't need to know the products
  // module exists.
  r.post(
    '/bot/analyze/:id/listings/:productId/approve',
    {
      schema: {
        tags: ['bot'],
        summary: 'Publish a single draft listing (isAvailable=true).',
        params: z.object({ id: uuidSchema, productId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ ok: z.boolean() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.productId } });
        if (!product || product.deletedAt) throw notFound('Product not found.');
        await tx.product.update({
          where: { id: product.id },
          data: { isAvailable: true },
        });
        return { data: { ok: true } };
      }),
  );

  // ---------- POST /bot/analyze/:id/listings/:productId/deny --------------
  r.post(
    '/bot/analyze/:id/listings/:productId/deny',
    {
      schema: {
        tags: ['bot'],
        summary: 'Soft-delete a single draft listing.',
        params: z.object({ id: uuidSchema, productId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ ok: z.boolean() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.productId } });
        if (!product || product.deletedAt) throw notFound('Product not found.');
        await tx.product.update({
          where: { id: product.id },
          data: { deletedAt: new Date() },
        });
        return { data: { ok: true } };
      }),
  );

  // ---------- GET /bot/knowledge-base ----------
  r.get(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'List KB entries (any source).',
        querystring: z.object({
          q: z.string().trim().optional(),
          kind: z.string().optional(),
          approved: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: listEnvelopeSchema(kbEntryDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const q = req.query;
        const rows = await tx.knowledgeBaseEntry.findMany({
          where: {
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.approved ? { approved: q.approved === 'true' } : {}),
            ...(q.q
              ? { searchText: { contains: q.q.toLowerCase() } }
              : {}),
          },
          orderBy: [{ approved: 'asc' }, { updatedAt: 'desc' }],
          take: 200,
        });
        return {
          data: rows.map((e) => ({
            id: e.id,
            kind: e.kind,
            question: e.question,
            answer: e.answer,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            approved: e.approved,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /bot/knowledge-base ----------
  r.post(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'Add a manual KB entry.',
        body: z.object({
          kind: z.enum(['faq', 'product', 'service', 'policy', 'business_info', 'custom']),
          question: z.string().trim().min(1).max(500),
          answer: z.string().trim().min(1).max(2000),
        }),
        response: { 201: itemEnvelopeSchema(kbEntryDto) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) =>
      app.tenant(req, async (tx) => {
        const e = await tx.knowledgeBaseEntry.create({
          data: {
            organizationId: req.auth!.organizationId,
            kind: req.body.kind,
            question: req.body.question,
            answer: req.body.answer,
            sourceType: 'manual',
            approved: true,
            searchText: `${req.body.question} ${req.body.answer}`.toLowerCase(),
          },
        });
        reply.code(201);
        return {
          data: {
            id: e.id,
            kind: e.kind,
            question: e.question,
            answer: e.answer,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            approved: e.approved,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          },
        };
      }),
  );

  // ---------- PATCH /bot/knowledge-base/:id ----------
  r.patch(
    '/bot/knowledge-base/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Edit / approve a KB entry.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          question: z.string().trim().min(1).max(500).optional(),
          answer: z.string().trim().min(1).max(2000).optional(),
          kind: z.enum(['faq', 'product', 'service', 'policy', 'business_info', 'custom']).optional(),
          approved: z.boolean().optional(),
        }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const existing = await tx.knowledgeBaseEntry.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Entry not found.');
        const q = req.body.question ?? existing.question;
        const a = req.body.answer ?? existing.answer;
        await tx.knowledgeBaseEntry.update({
          where: { id: existing.id },
          data: {
            question: req.body.question,
            answer: req.body.answer,
            kind: req.body.kind,
            approved: req.body.approved,
            searchText: `${q} ${a}`.toLowerCase().slice(0, 4000),
          },
        });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /bot/knowledge-base/:id ----------
  r.delete(
    '/bot/knowledge-base/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete a KB entry.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.knowledgeBaseEntry.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /bot/knowledge-base ----------
  // Bulk wipe every KB entry for the org. Useful when a previous crawl /
  // import left stale facts that the bot keeps citing (e.g. "yoga mats"
  // on a juice-bar account). Admin-only — destructive + non-reversible.
  r.delete(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete every KB entry for this org (irreversible).',
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const r = await tx.knowledgeBaseEntry.deleteMany({});
        return r.count;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'knowledge_base_entry',
        metadata: { event: 'kb_wiped_all', count: result },
      });
      return { data: { deleted: result } };
    },
  );

  // ---------- POST /bot/factory-reset ----------
  // Nuke EVERY data source the bot grounds its replies on, so the next
  // simulator turn produces only catalog-derived answers. Useful when the
  // bot keeps citing facts that no longer match the business (yoga mats
  // on a juice-bar org is the canonical example).
  //
  // Wipes:
  //   - every KnowledgeBaseEntry row
  //   - every BotConversationFlowOption row (the recommender's candidates,
  //     including the currently-selected one)
  //   - every BotTestScenario + BotTestRun row
  //   - BotConfig.conversationFlow → null
  //   - BotConfig.responseTemplates → null
  //   - BotConfig.customPersonality → null
  //   - BotConfig.greeting          → null
  //
  // Does NOT touch:
  //   - Product / Service / Category rows (use catalog UI for that)
  //   - BusinessInfo (use /business-info)
  //   - FAQ / Policy rows (use /business-info tabs)
  //   - WhatsApp channel config / templates / deployment state
  //
  // Admin-only + irreversible.
  r.post(
    '/bot/factory-reset',
    {
      schema: {
        tags: ['bot'],
        summary: 'Wipe every bot-grounding source (KB + flows + scenarios + config text).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              kbDeleted: z.number(),
              flowsDeleted: z.number(),
              scenariosDeleted: z.number(),
              runsDeleted: z.number(),
              configCleared: z.boolean(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const kb = await tx.knowledgeBaseEntry.deleteMany({});
        const flows = await tx.botConversationFlowOption.deleteMany({});
        const runs = await tx.botTestRun.deleteMany({});
        const scenarios = await tx.botTestScenario.deleteMany({});
        // Null out the bot-config text fields without dropping the row —
        // operator can still tweak personality / greeting afterwards from
        // the UI, and BotConfig.id is referenced elsewhere (deployment
        // state, version counter).
        let configCleared = false;
        const existing = await tx.botConfig.findUnique({
          where: { organizationId: orgId },
        });
        if (existing) {
          await tx.botConfig.update({
            where: { id: existing.id },
            data: {
              conversationFlow: undefined as never,
              responseTemplates: undefined as never,
              customPersonality: null,
              greeting: null,
            },
          });
          // Prisma's `undefined` skips the column — to actually NULL JSON
          // columns we need a raw update.
          await tx.$executeRawUnsafe(
            `UPDATE bot_configs SET conversation_flow = NULL, response_templates = NULL WHERE id = $1`,
            existing.id,
          );
          configCleared = true;
        }
        return {
          kbDeleted: kb.count,
          flowsDeleted: flows.count,
          scenariosDeleted: scenarios.count,
          runsDeleted: runs.count,
          configCleared,
        };
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_config',
        metadata: { event: 'bot_factory_reset', ...result },
      });
      return { data: result };
    },
  );

  // ---------- POST /bot/knowledge-base/approve-all ----------
  r.post(
    '/bot/knowledge-base/approve-all',
    {
      schema: {
        tags: ['bot'],
        summary: 'One-click approve every AI-generated KB entry that is still in review.',
        response: { 200: itemEnvelopeSchema(z.object({ approved: z.number() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const result = await tx.knowledgeBaseEntry.updateMany({
          where: { sourceType: 'ai', approved: false },
          data: { approved: true },
        });
        return { data: { approved: result.count } };
      }),
  );

  // ---------- GET /bot/questionnaire ----------
  // Returns 5–10 questions targeted at gaps in the current config + KB.
  // For now this is rule-based (cheap, deterministic). LLM-driven adaptive
  // questions are a polish item.
  r.get(
    '/bot/questionnaire',
    {
      schema: {
        tags: ['bot'],
        summary: 'Adaptive 5–10 question fill-the-gap questionnaire.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const [config, biz, faqsCount, policiesCount] = await Promise.all([
          tx.botConfig.findUnique({ where: { organizationId: req.auth!.organizationId } }),
          tx.businessInfo.findFirst({ where: { organizationId: req.auth!.organizationId } }),
          tx.fAQ.count({ where: { isPublished: true, visibility: 'public' } }),
          tx.policy.count({ where: { isPublished: true } }),
        ]);
        const questions: { key: string; question: string; suggested?: string }[] = [];
        if (!config?.greeting)
          questions.push({
            key: 'greeting',
            question: 'How would you like the bot to say hello?',
            suggested: `Hi! Welcome to ${biz?.legalName ?? 'us'}. How can I help today?`,
          });
        if (!config?.personality && !config?.detectedTone)
          questions.push({
            key: 'personality',
            question: 'Which personality fits your brand best?',
            suggested: 'friendly',
          });
        if (!config?.escalationRules)
          questions.push({
            key: 'escalation_fallback',
            question: 'What should the bot say when it needs to hand off to a human?',
            suggested: "I'll connect you with a teammate — they'll be with you shortly.",
          });
        if (!biz?.operatingHours)
          questions.push({
            key: 'operating_hours',
            question: 'What are your opening hours? (Add them under Business Info.)',
          });
        if (faqsCount < 3)
          questions.push({
            key: 'add_faqs',
            question: 'Add at least 3 FAQs your customers ask weekly. (Business Info → FAQs.)',
          });
        if (policiesCount === 0)
          questions.push({
            key: 'add_policies',
            question: 'Add a returns + privacy policy so the bot can quote them.',
          });
        if (!config?.languages || config?.languages === 'en')
          questions.push({
            key: 'languages',
            question: 'Which languages should the bot reply in?',
            suggested: 'en',
          });
        return { data: questions };
      }),
  );

  // ---------- POST /bot/simulate ----------
  r.post(
    '/bot/simulate',
    {
      schema: {
        tags: ['bot'],
        summary: 'Live preview turn — runs the bot engine for one user message.',
        body: z.object({
          sessionId: z.string().min(1).max(120),
          message: z.string().trim().min(1).max(4000),
        }),
        response: {
          200: itemEnvelopeSchema(z.object({ reply: z.string(), usedKbCount: z.number().int() })),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured on this deployment.',
        );
      }
      const orgId = req.auth!.organizationId;
      // tx1: gather all data (history + KB + catalog) and persist the user
      // turn. Read-heavy, no network — closes well under the 5s tx timeout.
      const { data, history } = await app.tenant(req, async (tx) => {
        const [data, history] = await Promise.all([
          gatherBotData(tx, orgId),
          tx.botSimulationTurn.findMany({
            where: { organizationId: orgId, sessionId: req.body.sessionId },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        ]);
        await tx.botSimulationTurn.create({
          data: { organizationId: orgId, sessionId: req.body.sessionId, role: 'user', body: req.body.message },
        });
        return { data, history: history.reverse() };
      });

      // OpenAI call — outside any tx, can take 5–15s without breaking
      // anything.
      const reply = await buildBotResponse({
        organizationId: orgId,
        userMessage: req.body.message,
        history: history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.body })),
        data,
      });

      // tx2: persist the assistant turn. Fire-and-forget'ish — if this
      // fails the user still got their reply, but we log + propagate so
      // the route returns 500 instead of a phantom-success.
      await app.tenant(req, async (tx) => {
        await tx.botSimulationTurn.create({
          data: { organizationId: orgId, sessionId: req.body.sessionId, role: 'assistant', body: reply.text },
        });
      });

      return { data: { reply: reply.text, usedKbCount: reply.usedKbCount } };
    },
  );

  // ---------- POST /bot/scenarios/generate ----------
  // Build a fresh set of scenarios from the CURRENT knowledge base + catalog.
  // Wipes existing ai_generated scenarios + their runs; preserves any manual
  // ones the operator authored.
  r.post(
    '/bot/scenarios/generate',
    {
      schema: {
        tags: ['bot'],
        summary: 'Regenerate test scenarios from the current KB (wipes prior AI ones).',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));
      const generated = await generateScenariosFromKb(orgId, data);

      const written = await app.tenant(req, async (tx) => {
        // Wipe AI-generated scenarios + their runs. Manual ones are kept.
        const stale = await tx.botTestScenario.findMany({
          where: { source: 'ai_generated' },
          select: { key: true },
        });
        const staleKeys = stale.map((s) => s.key);
        if (staleKeys.length > 0) {
          await tx.botTestRun.deleteMany({ where: { scenarioKey: { in: staleKeys } } });
          await tx.botTestScenario.deleteMany({
            where: { source: 'ai_generated' },
          });
        }
        const rows = [];
        for (let i = 0; i < generated.length; i++) {
          const g = generated[i]!;
          const row = await tx.botTestScenario.upsert({
            where: { organizationId_key: { organizationId: orgId, key: g.key } },
            update: { prompt: g.prompt, expectation: g.expectation, source: 'ai_generated', sortOrder: i },
            create: {
              organizationId: orgId,
              key: g.key,
              prompt: g.prompt,
              expectation: g.expectation,
              source: 'ai_generated',
              sortOrder: i,
            },
          });
          rows.push(row);
        }
        return rows;
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        metadata: { event: 'scenarios_generated', count: written.length },
      });
      return {
        data: {
          scenarios: written.map((s) => ({
            id: s.id,
            key: s.key,
            prompt: s.prompt,
            expectation: s.expectation,
            source: s.source,
          })),
        },
      };
    },
  );

  // ---------- DELETE /bot/scenarios ----------
  // Wipe ALL scenarios (manual + AI) and their runs. Used when the operator
  // wants a clean slate before a regenerate.
  r.delete(
    '/bot/scenarios',
    {
      schema: { tags: ['bot'], summary: 'Delete every test scenario + its run history.', response: { 200: successSchema } },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const before = await tx.botTestScenario.count();
        await tx.botTestRun.deleteMany({});
        await tx.botTestScenario.deleteMany({});
        return before;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        metadata: { event: 'scenarios_deleted_all', count: result },
      });
      return { ok: true as const };
    },
  );

  // ---------- DELETE /bot/scenarios/:id ----------
  r.delete(
    '/bot/scenarios/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete one scenario + its run history.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const row = await tx.botTestScenario.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Scenario not found.');
        await tx.botTestRun.deleteMany({ where: { scenarioKey: row.key } });
        await tx.botTestScenario.delete({ where: { id: row.id } });
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        entityId: req.params.id,
        metadata: { event: 'scenario_deleted' },
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /bot/scenarios/run ----------
  // Runs every scenario the org has in the DB + LLM-judges each. If the org
  // has NO scenarios yet (fresh install or operator just deleted them all),
  // we auto-generate a fresh batch from the current KB first — so the
  // operator's "Run all" click after a KB refresh always produces a NEW set.
  r.post(
    '/bot/scenarios/run',
    {
      schema: {
        tags: ['bot'],
        summary: 'Run every saved scenario + LLM-judge. Auto-generates from KB if none saved.',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));

      // Auto-generate when empty so the button is never a no-op.
      let scenarios = await app.tenant(req, (tx) =>
        tx.botTestScenario.findMany({ orderBy: { sortOrder: 'asc' } }),
      );
      if (scenarios.length === 0) {
        const fresh = await generateScenariosFromKb(orgId, data);
        scenarios = await app.tenant(req, async (tx) => {
          const rows = [];
          for (let i = 0; i < fresh.length; i++) {
            const g = fresh[i]!;
            const row = await tx.botTestScenario.upsert({
              where: { organizationId_key: { organizationId: orgId, key: g.key } },
              update: { prompt: g.prompt, expectation: g.expectation, source: 'ai_generated', sortOrder: i },
              create: {
                organizationId: orgId,
                key: g.key,
                prompt: g.prompt,
                expectation: g.expectation,
                source: 'ai_generated',
                sortOrder: i,
              },
            });
            rows.push(row);
          }
          return rows;
        });
      }

      const out: {
        id: string;
        key: string;
        prompt: string;
        reply: string;
        score: number;
        notes: string;
      }[] = [];

      for (const s of scenarios) {
        const reply = await buildBotResponse({
          organizationId: orgId,
          userMessage: s.prompt,
          data,
        });
        // LLM-as-judge.
        const judgeSys =
          'You are a strict QA judge. Score the bot reply 0–100 against the expectation. Return STRICT JSON: {"score": <int>, "notes": "<one short sentence>"}. No prose, no markdown.';
        const judgeUser = `Expectation:\n${s.expectation}\n\nBot reply:\n${reply.text}`;
        let score = 0;
        let notes = 'judge failed';
        try {
          const judge = await complete({
            organizationId: orgId,
            systemPrompt: judgeSys,
            messages: [{ role: 'user', content: judgeUser }],
            maxTokens: 200,
            temperature: 0.0,
          });
          const trimmed = judge.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
          const parsed = JSON.parse(trimmed) as { score?: number; notes?: string };
          if (typeof parsed.score === 'number') score = Math.max(0, Math.min(100, Math.round(parsed.score)));
          if (typeof parsed.notes === 'string') notes = parsed.notes;
        } catch {
          /* keep defaults */
        }
        await withTenant(orgId, (tx) =>
          tx.botTestRun.create({
            data: {
              organizationId: orgId,
              scenarioKey: s.key,
              scenarioPrompt: s.prompt,
              botResponse: reply.text,
              score,
              judgeNotes: notes,
            },
          }),
        );
        out.push({ id: s.id, key: s.key, prompt: s.prompt, reply: reply.text, score, notes });
      }
      const avg = out.reduce((a, b) => a + b.score, 0) / Math.max(1, out.length);
      return { data: { runs: out, averageScore: Math.round(avg) } };
    },
  );

  // ---------- GET /bot/scenarios/last ----------
  // Latest run for every scenario the org has saved. Falls back to the
  // scenario row itself (no run yet) so the UI can render a "not run yet"
  // state alongside the scored ones.
  r.get(
    '/bot/scenarios/last',
    {
      schema: { tags: ['bot'], summary: 'Latest test run per saved scenario.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const scenarios = await tx.botTestScenario.findMany({
          orderBy: { sortOrder: 'asc' },
        });
        const out = [];
        for (const s of scenarios) {
          const last = await tx.botTestRun.findFirst({
            where: { scenarioKey: s.key },
            orderBy: { createdAt: 'desc' },
          });
          out.push({
            id: s.id,
            key: s.key,
            prompt: s.prompt,
            expectation: s.expectation,
            source: s.source,
            runId: last?.id ?? null,
            reply: last?.botResponse ?? null,
            score: last?.score ?? null,
            notes: last?.judgeNotes ?? null,
            overrideScore: last?.overrideScore ?? null,
            overrideNotes: last?.overrideNotes ?? null,
            ranAt: last?.createdAt.toISOString() ?? null,
          });
        }
        return { data: out };
      }),
  );

  // ---------- POST /bot/conversation-flows/recommend ----------
  // Generate 3–5 conversation-flow CANDIDATES tailored to the business.
  // Replaces any prior unselected candidates so the operator sees a fresh
  // set. The previously-selected one (if any) is preserved + un-flagged
  // as recommended; the LLM picks a new recommended candidate.
  r.post(
    '/bot/conversation-flows/recommend',
    {
      schema: {
        tags: ['bot'],
        summary: 'Generate 3–5 conversation-flow candidates tailored to the business.',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));
      const candidates = await generateFlowCandidates(orgId, data);
      if (candidates.length === 0) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Could not generate flow candidates. Add some KB / products / services first.',
        );
      }

      const saved = await app.tenant(req, async (tx) => {
        // Wipe unselected candidates so the operator only sees the freshest
        // set. Keep the active one — switching mid-deploy would be jarring.
        await tx.botConversationFlowOption.deleteMany({ where: { isSelected: false } });
        // Clear any stale recommended flags on the surviving (selected) one.
        await tx.botConversationFlowOption.updateMany({
          where: { isSelected: true },
          data: { isRecommended: false },
        });
        const rows = [];
        for (const c of candidates) {
          const row = await tx.botConversationFlowOption.create({
            data: {
              organizationId: orgId,
              name: c.name,
              description: c.description,
              flow: c.flow as never,
              isRecommended: c.isRecommended,
              recommendReason: c.recommendReason,
              isSelected: false,
            },
          });
          rows.push(row);
        }
        return rows;
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        metadata: { event: 'flow_candidates_generated', count: saved.length },
      });
      return {
        data: {
          candidates: saved.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            isRecommended: c.isRecommended,
            recommendReason: c.recommendReason,
            isSelected: c.isSelected,
            flow: c.flow as Record<string, unknown>,
          })),
        },
      };
    },
  );

  // ---------- GET /bot/conversation-flows ----------
  r.get(
    '/bot/conversation-flows',
    {
      schema: { tags: ['bot'], summary: 'List conversation-flow candidates for this org.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.botConversationFlowOption.findMany({
          orderBy: [{ isSelected: 'desc' }, { isRecommended: 'desc' }, { createdAt: 'asc' }],
        });
        return {
          data: rows.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            isRecommended: c.isRecommended,
            recommendReason: c.recommendReason,
            isSelected: c.isSelected,
            flow: c.flow as Record<string, unknown>,
            createdAt: c.createdAt.toISOString(),
          })),
        };
      }),
  );

  // ---------- POST /bot/conversation-flows/:id/select ----------
  // Mark a candidate as the active flow and mirror its JSON onto the
  // BotConfig so the runtime keeps a single source of truth.
  r.post(
    '/bot/conversation-flows/:id/select',
    {
      schema: {
        tags: ['bot'],
        summary: 'Select a candidate as the active conversation flow.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const updated = await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        await tx.botConversationFlowOption.updateMany({ data: { isSelected: false } });
        const selected = await tx.botConversationFlowOption.update({
          where: { id: row.id },
          data: { isSelected: true },
        });
        // Mirror onto BotConfig so the runtime keeps reading one source.
        await tx.botConfig.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, conversationFlow: selected.flow as never },
          update: { conversationFlow: selected.flow as never },
        });
        return selected;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        entityId: updated.id,
        metadata: { event: 'flow_selected', name: updated.name },
      });
      return {
        data: {
          id: updated.id,
          name: updated.name,
          isSelected: updated.isSelected,
        },
      };
    },
  );

  // ---------- PATCH /bot/conversation-flows/:id ----------
  // Edit a candidate's name, description, or flow JSON. Edits to the
  // currently-selected candidate are mirrored onto BotConfig.
  r.patch(
    '/bot/conversation-flows/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Edit a conversation-flow candidate.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          description: z.string().trim().min(1).max(400).optional(),
          flow: z
            .object({
              nodes: z.array(
                z.object({
                  intent: z.string().trim().min(1).max(40),
                  label: z.string().trim().min(1).max(80),
                  response: z.string().trim().min(1).max(600),
                }),
              ),
            })
            .optional(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const updated = await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        const next = await tx.botConversationFlowOption.update({
          where: { id: row.id },
          data: {
            name: req.body.name ?? undefined,
            description: req.body.description ?? undefined,
            flow: req.body.flow === undefined ? undefined : (req.body.flow as never),
          },
        });
        if (next.isSelected && req.body.flow !== undefined) {
          await tx.botConfig.update({
            where: { organizationId: orgId },
            data: { conversationFlow: next.flow as never },
          });
        }
        return next;
      });
      return {
        data: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          flow: updated.flow as Record<string, unknown>,
        },
      };
    },
  );

  // ---------- DELETE /bot/conversation-flows/:id ----------
  // Remove a candidate. Refuses to delete the currently-selected one — the
  // operator must pick another candidate first so the bot never has no
  // active flow.
  r.delete(
    '/bot/conversation-flows/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete a conversation-flow candidate (must not be selected).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        if (row.isSelected) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Cannot delete the currently-selected flow. Select a different one first.',
          );
        }
        await tx.botConversationFlowOption.delete({ where: { id: row.id } });
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        entityId: req.params.id,
        metadata: { event: 'flow_candidate_deleted' },
      });
      return { ok: true as const };
    },
  );

  // ---------- PATCH /bot/scenarios/runs/:id ----------
  // Operator override on a specific test-run's score. Lets the team
  // disagree with the LLM judge when the judge prompt is overly strict
  // or misses nuance. The original LLM `score` + `judgeNotes` are kept
  // verbatim; the human signal lives in overrideScore / overrideNotes.
  r.patch(
    '/bot/scenarios/runs/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Operator override of an LLM judge score (0..100) + notes.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          overrideScore: z.number().int().min(0).max(100).nullable(),
          overrideNotes: z.string().trim().max(2000).optional().nullable(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const row = await tx.botTestRun.findFirst({ where: { id: req.params.id } });
        if (!row) throw notFound('Test run not found.');
        const updated = await tx.botTestRun.update({
          where: { id: row.id },
          data: {
            overrideScore: req.body.overrideScore,
            overrideNotes: req.body.overrideNotes ?? null,
            overrideByUserId: req.body.overrideScore === null ? null : req.auth!.userId,
            overrideAt: req.body.overrideScore === null ? null : new Date(),
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_test_run',
          entityId: updated.id,
          metadata: {
            event: req.body.overrideScore === null ? 'judge_override_cleared' : 'judge_override_set',
            scenarioKey: updated.scenarioKey,
            overrideScore: req.body.overrideScore,
          },
        });
        return {
          data: {
            id: updated.id,
            overrideScore: updated.overrideScore,
            overrideNotes: updated.overrideNotes,
          },
        };
      });
    },
  );

  // ---------- POST /bot/deploy ----------
  r.post(
    '/bot/deploy',
    {
      schema: {
        tags: ['bot'],
        summary: 'Deploy the bot — flips deployedAt + auto-replies start in inbound webhook.',
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const cfg = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!cfg) throw notFound('Bot config not found.');
        const updated = await tx.botConfig.update({
          where: { id: cfg.id },
          data: { deployedAt: new Date() },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_config',
          entityId: updated.id,
          metadata: { event: 'bot_deployed', version: updated.version },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );

  // ---------- POST /bot/undeploy ----------
  r.post(
    '/bot/undeploy',
    {
      schema: {
        tags: ['bot'],
        summary: 'Roll back deployment — bot stops auto-replying.',
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const cfg = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!cfg) throw notFound('Bot config not found.');
        const updated = await tx.botConfig.update({
          where: { id: cfg.id },
          data: { deployedAt: null },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );
}
