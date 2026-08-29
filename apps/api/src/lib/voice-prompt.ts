// Voice prompt compiler — turns one tenant's BotData into a single system
// prompt for the OpenAI Realtime speech model running inside the Aseer-time
// voice media gateway, PLUS the structured order/booking form config the
// gateway uses to build its submit_order / submit_booking tool parameters.
//
// Differences from the WhatsApp prompt in bot-engine.ts, on purpose:
//   - One static prompt per tenant (no per-message top-K packing): the
//     realtime session is configured ONCE at call start, so everything the
//     bot may need must be in the prompt up front. Catalog is capped hard.
//   - Phone-call style rules: short spoken sentences, no lists, no emoji,
//     no markdown, no [IMAGE:]/[BOOKING:]/[CART:] markers — none of those
//     can be rendered on a voice call. Orders/bookings are completed by
//     CALLING the submit_order / submit_booking functions, not by emitting
//     markers.
//   - The escape hatch is the voicebot's `transfer_to_human` tool.
//
// Same non-negotiables as bot-engine.ts: never invent products, prices, or
// facts not present in the data, and never put literal example product names
// in instruction text (gpt models copy examples into real replies).
//
// All tenant-authored text is passed through clean()/cleanBlock() — HTML
// stripped (same defense the read API applies via stripHtmlForBot) and
// newlines collapsed on single-line fields so catalog data cannot fabricate
// instruction lines — and per-field caps + a total budget keep the compiled
// prompt well inside the realtime session's context.
import type { VoiceFormField, voiceConfigSchema } from '@platform/shared';
import type { z } from 'zod';

import type { BotData } from './bot-engine.js';
import { extractIntents, formatMoney, formatOperatingHours } from './bot-engine.js';
import { stripHtmlForBot } from '../modules/catalog/shared.js';

// Spoken-style variants of bot-engine's PERSONALITY_DESCRIPTIONS (those
// mention emoji + lists, which don't exist on a call).
const VOICE_PERSONALITY: Record<string, string> = {
  formal: 'Professional and precise. Full sentences, no slang.',
  casual: 'Conversational and relaxed. Contractions are fine.',
  friendly: 'Warm and helpful. Sound genuinely glad to help.',
  clinical: 'Concise and factual. No marketing language.',
  professional: 'Polite and direct. Clarity over warmth.',
};

// Mirrors bot-engine's LANGUAGE_NAMES so a tenant configured for, say,
// French is not silently forced to English.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  tr: 'Turkish',
  pt: 'Portuguese',
  it: 'Italian',
  ru: 'Russian',
  hi: 'Hindi',
  ur: 'Urdu',
  zh: 'Chinese',
};

// gatherBotData now loads up to 600 products / 300 services (it was widened so
// the WhatsApp ranker could see a whole catalog), so these compile-side caps are
// the REAL bound on what a caller can be told about — not documentation. A
// caller asking for item #31 of a 39-item menu got "we don't have that", which
// is worse than a long prompt: the bot confidently denies something the shop
// sells. MAX_PRODUCTS is therefore set high enough to carry a normal full menu,
// with TOTAL_BUDGET below as the real backstop, and anything actually dropped is
// reported in `truncatedSections` instead of vanishing silently.
const MAX_PRODUCTS = 120;
const MAX_SERVICES = 60;
const MAX_FAQS = 30;

// Per-field character caps (phone prompts need facts, not essays) and the
// total instructions budget. gpt-realtime sessions hold ~32k tokens; staying
// around 24k CHARS (~6k tokens) leaves the bulk of the window for the live
// conversation.
const CAP = {
  tagline: 200,
  about: 1200,
  shortDescription: 200,
  productDescription: 400,
  faqQuestion: 300,
  faqAnswer: 600,
  policy: 800,
  personality: 500,
  greeting: 300,
  fallback: 300,
  phrasing: 500,
};
const TOTAL_BUDGET = 24_000;

// Control chars (C0 except tab/newline) that could smuggle formatting into
// the prompt. Expressed as unicode escapes to keep this source pure ASCII.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// Single-line tenant text: strip HTML, collapse ALL whitespace (incl.
// newlines — a value spanning lines could otherwise mimic instruction
// bullets), truncate.
function clean(input: string | null | undefined, max: number): string | null {
  const stripped = stripHtmlForBot(input);
  if (!stripped) return null;
  const flat = stripped.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Multi-line tenant text (about, policies): strip HTML, drop control chars,
// collapse blank-line runs, truncate.
function cleanBlock(input: string | null | undefined, max: number): string | null {
  const stripped = stripHtmlForBot(input);
  if (!stripped) return null;
  const text = stripped
    .replace(/\r/g, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function languageRule(languages: string | null | undefined): string {
  const codes = [
    ...new Set(
      (languages ?? 'en')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((c) => LANGUAGE_NAMES[c]),
    ),
  ];
  if (codes.length === 0) codes.push('en');
  const hasAr = codes.includes('ar');
  const hasEn = codes.includes('en');

  if (hasAr && hasEn && codes.length === 2) {
    return (
      'Languages: speak ONLY English or Arabic — never any other language (French, Spanish, etc.) under any circumstance, even if the caller has a foreign-sounding name or mixes in the odd foreign word. ' +
      "Mirror the caller's Arabic dialect (Lebanese, Gulf, Egyptian, or MSA — match what you hear). " +
      'Lebanese and Gulf Arabic naturally sprinkle in English or French words — that is STILL Arabic, so keep replying in Arabic; do NOT switch to French. ' +
      'Start in English. If the caller speaks Arabic, switch and continue in Arabic; if they switch back, follow them.'
    );
  }
  if (codes.length === 1) {
    const only = LANGUAGE_NAMES[codes[0]!]!;
    return (
      `Languages: speak ONLY ${only} — never any other language under any circumstance.` +
      (codes[0] === 'ar' ? " Mirror the caller's dialect (Lebanese, Gulf, Egyptian, or MSA)." : '')
    );
  }
  const names = codes.map((c) => LANGUAGE_NAMES[c]!).join(', ');
  return (
    `Languages: speak ONLY one of: ${names} — never any other language under any circumstance. ` +
    "Start in the first listed language and follow the caller's switches between the listed languages." +
    (hasAr ? " For Arabic, mirror the caller's dialect." : '')
  );
}

// A tenant chat greeting is only usable on a call if it's plain spoken text —
// no emoji, markdown, URLs, or markers (those read terribly or break on a
// voice line). When it passes we honor the operator's wording (e.g. a French
// business that authored "Bonjour, bienvenue…"); otherwise we synthesize a
// neutral English opener.
function spokenSafeGreeting(raw: string | null | undefined): string | null {
  const g = clean(raw, CAP.greeting);
  if (!g) return null;
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(g)) return null; // emoji
  if (/[*_#`~|<>]|https?:\/\/|\[[A-Z_]+/.test(g)) return null; // markdown/URL/markers
  if (g.length > 160) return null;
  return g;
}

// Structured form config the gateway turns into dynamic tool params.
type VoiceConfigWire = z.infer<typeof voiceConfigSchema>;

function mapFields(
  fields: { key: string; label: string; type: string; required: boolean; options?: string[] }[],
): VoiceFormField[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    ...(f.options && f.options.length > 0 ? { options: f.options } : {}),
  }));
}

export interface CompiledVoiceConfig extends VoiceConfigWire {
  // Sections dropped to fit TOTAL_BUDGET (F3 — surfaced so the route can log
  // it instead of silently starving the bot of policies/FAQs).
  truncatedSections: string[];
}

export function compileVoiceConfig(
  data: BotData,
  orgName: string,
  // Precomputed open booking slots (operator-timezone labels). Empty = no
  // availability configured; the bot then takes any requested time.
  openSlots: string[] = [],
): CompiledVoiceConfig {
  const { config, biz, faqs, policies, locations, contactChannels, services } = data;
  const businessName = clean(biz?.legalName, 120) || clean(orgName, 120) || 'this business';
  // Org currency wins over the per-row column, same as bot-engine
  // (formatMoney(p.priceMinor, biz?.currency ?? p.currency)).
  const orgCurrency = biz?.currency ?? null;

  const personalityKey = config?.personality ?? config?.detectedTone ?? 'friendly';
  const personality =
    clean(config?.customPersonality, CAP.personality) ||
    VOICE_PERSONALITY[personalityKey] ||
    VOICE_PERSONALITY.friendly!;

  const sections: string[] = [];
  // Sections dropped to fit the caps/budget — surfaced so the route logs it
  // rather than the bot silently denying items it actually sells.
  const truncatedSections: string[] = [];

  sections.push(
    `You are the AI phone receptionist for ${businessName}. You are on a live phone call with a customer.`,
  );

  sections.push(
    [
      'STRICT CALL RULES:',
      `- SCOPE LOCK (YOUR #1 RULE, OVERRIDES EVERYTHING): You are EXCLUSIVELY the assistant for ${businessName}. Only help with THIS business — its products, services, prices, hours, locations, orders, bookings, and the BUSINESS DATA below. You are FORBIDDEN from answering anything else even if you know it: general knowledge, history, war, politics, science, math or arithmetic, geography, news, other companies, advice, jokes, or trivia. If the caller asks something off-topic, do NOT answer it — say ONE short friendly line in their language declining and steering back, like "Sorry, I can only help with ${businessName} — would you like to hear our menu or place an order?". Never use outside or general knowledge.`,
      `- Tone: ${personality}`,
      `- ${languageRule(config?.languages)}`,
      '- Keep every reply under 25 words. Natural spoken sentences only — no lists, no bullet points, no emoji, no markdown, nothing that only works in writing.',
      '- Greet ONCE at the very start of the call and never re-greet.',
      "- Only state facts found in the BUSINESS DATA below. If the answer is not there, say you will have someone follow up and offer to take the caller's name and number — never invent or guess products, prices, hours, or policies.",
      '- When taking an order, booking, or message, read back the key details (name, number, time, items) before confirming.',
      '- Never ask for card numbers or payment details. If the caller wants to pay, say a payment link will be sent.',
      '- The caller speaks; they cannot press dial-pad keys to make selections — ask them to SAY their choices, never to "press" a number.',
      "- SILENCE / UNCLEAR AUDIO: if the caller is quiet, hasn't spoken yet, or you didn't catch what they said, do NOT transfer and do NOT hang up — warmly say one short line like \"Sorry, I didn't catch that — could you say that again?\" and keep waiting. Treat the start of the call as the caller still gathering their words; give them time. Silence or a missed word is NEVER a reason to transfer.",
      '- If the caller asks something that is not in the BUSINESS DATA, do NOT transfer — answer what you can, then offer to take their name and number so someone can follow up.',
      '- HUMAN TRANSFER — use this ONLY when the caller EXPLICITLY asks for a human, agent, person, representative, or manager, OR raises a complaint, refund, or sensitive issue you cannot resolve. Then say ONE short line in their language like "Sure, connecting you to a colleague now, please hold" and immediately call the transfer_to_human function, and stop. Never call transfer_to_human for any other reason — especially not for silence, unclear audio, or a question you simply do not know the answer to.',
    ].join('\n'),
  );

  // ---- TAKING ORDERS — field-driven (parity with the WhatsApp shop flow) ----
  const shop = data.shopForm;
  if (shop) {
    const cur = orgCurrency ?? shop.currency ?? 'USD';
    const fieldLines = shop.fields.map((f) => {
      const choices = f.options && f.options.length > 0 ? ` (say one of: ${f.options.join(', ')})` : '';
      return `  • "${f.label}"${f.required ? '' : ' (optional)'}${choices}`;
    });
    const min = shop.minOrderMinor != null ? formatMoney(shop.minOrderMinor, cur) : null;
    const fee = shop.deliveryFeeMinor != null ? formatMoney(shop.deliveryFeeMinor, cur) : null;
    const freeAbove =
      shop.freeDeliveryAboveMinor != null ? formatMoney(shop.freeDeliveryAboveMinor, cur) : null;
    const confirmLine = clean(shop.confirmationMessage, 300);
    const intents =
      shop.intentKeywords && shop.intentKeywords.length > 0
        ? shop.intentKeywords.join(', ')
        : 'order, buy, delivery, menu';

    sections.push(
      [
        'TAKING ORDERS (you can place orders for callers):',
        `- Enter order mode when the caller wants to order/buy (any of: ${intents}).`,
        '- Take orders ONLY for items in the menu under BUSINESS DATA, and quote prices ONLY from there. If a caller asks for something not on the menu, say it is unavailable — never invent items or prices.',
        `- Prices are in ${cur}.${fee ? ` Delivery costs ${fee}${freeAbove ? `, free over ${freeAbove}` : ''} — state it in the summary.` : ''}`,
        '- On each item the caller adds, confirm it with its price and the running subtotal so far.',
        fieldLines.length > 0
          ? `- Besides the items, collect these details, asking one or two at a time, using the exact wording:\n${fieldLines.join('\n')}`
          : '- Besides the items, collect the customer\'s name.',
        "- Also collect the customer's name and a WhatsApp number to send the bill to (default to the number they are calling from — read it back to confirm).",
        min
          ? `- Minimum order is ${min}. If the subtotal is below that, tell the caller and ask them to add more — do NOT place the order until it meets the minimum.`
          : '',
        '- When the caller says that is everything, READ BACK the full order — every item with its quantity, the details you collected, the delivery fee if any, and the GRAND TOTAL — and ask them to confirm.',
        '- ONLY after they clearly confirm, call the submit_order function with the items (each item\'s name and quantity), the customer name, the WhatsApp/phone number, and EVERY detail you collected. Do NOT say the order is placed until the function returns a confirmation.',
        '- If the caller says they want to ADD to an order they already have in progress (see CALLER CONTEXT if present), pass continueExisting=true to submit_order so it is merged, not duplicated.',
        `- After the function confirms, tell the caller the order is placed, read the total, and let them know a payment link is being sent to their WhatsApp now.${confirmLine ? ` You may close with: "${confirmLine}"` : ''} Never take card or payment-card numbers.`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // ---- TAKING BOOKINGS — field-driven (parity with the WhatsApp booking flow)
  const booking = data.bookingForm;
  if (booking) {
    const fieldLines = booking.fields.map(
      (f) => `  • "${f.label}"${f.required ? '' : ' (optional)'}`,
    );
    const tz = booking.availability?.timezone || null;
    const intents =
      booking.intentKeywords && booking.intentKeywords.length > 0
        ? booking.intentKeywords.join(', ')
        : 'book, appointment, reservation, schedule, reserve';

    sections.push(
      [
        'TAKING BOOKINGS (you can schedule appointments):',
        `- Enter booking mode when the caller wants to book/schedule/reserve a "${booking.title}" (any of: ${intents}).`,
        fieldLines.length > 0
          ? `- Collect these details, asking one or two at a time, using the exact wording:\n${fieldLines.join('\n')}`
          : '',
        "- Also collect the caller's name and a phone number.",
        openSlots.length > 0
          ? `- For the date and time you may ONLY offer these open slots${tz ? ` (times are ${tz})` : ''}; say a few of them. If the caller asks for a time that is not in this list, tell them it is unavailable and offer the closest open one. NEVER invent or accept a time that is not listed:\n${openSlots
              .slice(0, 8)
              .map((s) => `  • ${s}`)
              .join('\n')}`
          : '- For the date and time, pin it down clearly: always confirm AM vs PM and resolve relative words ("tomorrow", "Friday") to an explicit date before continuing.',
        '- Read back every detail and the chosen time, and ask the caller to confirm.',
        '- ONLY after they clearly confirm, call the submit_booking function with every detail you collected (store the date/time as the exact slot you offered). Do NOT say it is booked until the function returns a confirmation.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // ---- BUSINESS DATA -------------------------------------------------------
  const dataLines: string[] = ['BUSINESS DATA (the only source of truth):'];

  if (biz) {
    const bizLines: string[] = [`Business: ${businessName}`];
    const tagline = clean(biz.tagline, CAP.tagline);
    if (tagline) bizLines.push(`Tagline: ${tagline}`);
    const about = cleanBlock(biz.about, CAP.about);
    if (about) bizLines.push(`About: ${about}`);
    if (biz.websiteUrl) bizLines.push(`Website: ${clean(biz.websiteUrl, 200)}`);
    const hours = formatOperatingHours(biz.operatingHours);
    if (hours) bizLines.push(`Opening hours:\n${hours}`);
    dataLines.push(bizLines.join('\n'));
  }

  if (locations.length > 0) {
    dataLines.push(
      'Locations:\n' +
        locations
          .map((l) => {
            const addr = [l.addressLine1, l.addressLine2, l.city, l.region, l.country]
              .filter(Boolean)
              .join(', ');
            const bits = [
              clean(l.name, 80),
              clean(addr, 200),
              l.phone ? `phone ${clean(l.phone, 40)}` : null,
            ].filter(Boolean);
            return `- ${bits.join(' — ')}${l.isPrimary ? ' (main branch)' : ''}`;
          })
          .join('\n'),
    );
  }

  if (contactChannels.length > 0) {
    dataLines.push(
      'Contact channels:\n' +
        contactChannels
          .map((c) => `- ${clean(c.label ?? c.kind, 60)}: ${clean(c.value, 120)}`)
          .join('\n'),
    );
  }

  if (data.products.length > 0) {
    const capped = data.products.slice(0, MAX_PRODUCTS);
    if (data.products.length > capped.length) {
      truncatedSections.push(`products(${capped.length}/${data.products.length})`);
    }
    dataLines.push(
      `Products / menu (${capped.length} items; if a caller asks for something not listed, treat it as unknown — do not guess):\n` +
        capped
          .map((p) => {
            const price = formatMoney(p.priceMinor, orgCurrency ?? p.currency);
            const variants = p.variants
              .map(
                (v) =>
                  `${clean(v.name, 60)}${v.priceMinor != null ? ` ${formatMoney(v.priceMinor, orgCurrency ?? p.currency)}` : ''}`,
              )
              .join(', ');
            // Prefer the full description (allergen / nutrition / spec detail a
            // caller may ask about) then fall back to the short one — parity
            // with the WhatsApp prompt, which uses description || shortDescription.
            const desc =
              cleanBlock(p.description, CAP.productDescription) ||
              clean(p.shortDescription, CAP.shortDescription);
            return [
              `- ${clean(p.name, 120)}`,
              price ? ` — ${price}` : '',
              p.categoryName ? ` (${clean(p.categoryName, 60)})` : '',
              variants ? ` [${variants}]` : '',
              desc ? `: ${desc}` : '',
            ].join('');
          })
          .join('\n'),
    );
  }

  if (services.length > 0) {
    if (services.length > MAX_SERVICES) {
      truncatedSections.push(`services(${MAX_SERVICES}/${services.length})`);
    }
    dataLines.push(
      'Services:\n' +
        services
          .slice(0, MAX_SERVICES)
          .map((s) => {
            const price = formatMoney(s.basePriceMinor, orgCurrency ?? s.currency);
            const desc = clean(s.shortDescription, CAP.shortDescription);
            return [
              `- ${clean(s.name, 120)}`,
              price ? ` — from ${price}` : '',
              s.durationMinutes ? ` (${s.durationMinutes} min)` : '',
              desc ? `: ${desc}` : '',
            ].join('');
          })
          .join('\n'),
    );
  }

  let faqSection: string | null = null;
  if (faqs.length > 0) {
    faqSection =
      'FAQs:\n' +
      faqs
        .slice(0, MAX_FAQS)
        .map((f) => `Q: ${clean(f.question, CAP.faqQuestion)}\nA: ${cleanBlock(f.answer, CAP.faqAnswer)}`)
        .join('\n');
    dataLines.push(faqSection);
  }

  let policySection: string | null = null;
  if (policies.length > 0) {
    policySection =
      'Policies:\n' +
      policies
        .map((p) => `- ${clean(p.title, 100)}: ${cleanBlock(p.content, CAP.policy)}`)
        .join('\n');
    dataLines.push(policySection);
  }

  sections.push(dataLines.join('\n\n'));

  // Operator-authored preferred phrasings (Conversation flow / response
  // templates) — parity with the WhatsApp prompt, which embeds these so the
  // bot answers labelled intents in the operator's on-brand wording.
  const intents = extractIntents(config?.conversationFlow, config?.responseTemplates);
  if (intents.length > 0) {
    sections.push(
      'PREFERRED PHRASINGS (use this wording when the caller asks about these topics; keep it spoken and short):\n' +
        intents
          .slice(0, 12)
          .map((i) => `- ${clean(i.label, 80)}: ${clean(i.response, CAP.phrasing)}`)
          .join('\n'),
    );
  }

  // Operator-authored escalation fallback wording, if any.
  const escalation = (config?.escalationRules ?? {}) as Record<string, unknown>;
  const fallback =
    typeof escalation.fallback === 'string' ? clean(escalation.fallback, CAP.fallback) : null;
  if (fallback) {
    sections.push(`When you cannot help and no human is reachable, say: "${fallback}"`);
  }

  // Total budget: drop the heaviest optional sections (policies first, then
  // FAQs) rather than serving a prompt that crowds out the conversation.
  let instructions = sections.join('\n\n');
  if (instructions.length > TOTAL_BUDGET && policySection) {
    instructions = instructions.replace(`\n\n${policySection}`, '');
    truncatedSections.push('policies');
  }
  if (instructions.length > TOTAL_BUDGET && faqSection) {
    instructions = instructions.replace(`\n\n${faqSection}`, '');
    truncatedSections.push('faqs');
  }
  if (instructions.length > TOTAL_BUDGET) {
    instructions = instructions.slice(0, TOTAL_BUDGET);
    truncatedSections.push('hard-cut');
  }

  // Voice opens with the operator's spoken greeting when it's call-safe,
  // otherwise a synthesized English opener (the language rule then mirrors the
  // caller). The tenant's BotConfig.greeting is authored for chat (often
  // Arabizi / emoji), so it only wins when spokenSafeGreeting accepts it.
  const greeting =
    spokenSafeGreeting(config?.greeting) ??
    `Hello, thanks for calling ${businessName}. How can I help you today?`;

  // Structured form config for the gateway's dynamic tool params.
  const orderForm: VoiceConfigWire['orderForm'] = shop
    ? {
        title: clean(shop.title, 120) || 'Order',
        currency: orgCurrency ?? shop.currency ?? 'USD',
        fields: mapFields(shop.fields),
        minOrderMinor: shop.minOrderMinor,
        deliveryFeeMinor: shop.deliveryFeeMinor,
        freeDeliveryAboveMinor: shop.freeDeliveryAboveMinor,
        confirmationMessage: clean(shop.confirmationMessage, 300),
        intentKeywords: shop.intentKeywords ?? [],
      }
    : null;
  const bookingFormWire: VoiceConfigWire['bookingForm'] = booking
    ? {
        title: clean(booking.title, 120) || 'Booking',
        fields: mapFields(booking.fields),
        intentKeywords: booking.intentKeywords ?? [],
        timezone: booking.availability?.timezone ?? null,
        openSlots: openSlots.slice(0, 8),
      }
    : null;

  return {
    instructions,
    greeting,
    languages: config?.languages ?? 'en',
    businessName,
    orderForm,
    bookingForm: bookingFormWire,
    truncatedSections,
  };
}
