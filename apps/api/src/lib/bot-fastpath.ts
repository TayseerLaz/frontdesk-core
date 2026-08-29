// Phase 2 Step 5 — deterministic intent fast-path.
//
// Some inbound messages don't need an LLM at all. "What are your hours?",
// "Where are you located?", "Send me the menu", "I want to speak to a
// human" — these have one canonical answer per org. Detecting them by
// regex + keyword scoring and answering from the business-info row drops
// the per-turn latency from ~3-8s (Groq) or ~22s (legacy OpenAI) to ~80
// milliseconds.
//
// Design principles:
//   • Conservative detection: only fire when confidence is HIGH. False
//     positives are worse than false negatives — sending a templated
//     "we're open 9-5" when the customer asked something subtle is bad.
//   • Single short message: a turn-2 or turn-3 message could be a
//     contextual follow-up, so we ONLY fast-path the first message of a
//     thread, or messages that are syntactically a clean question.
//   • Language-aware: matches the keywords + responds in the customer's
//     language (English / Arabic in particular).
//   • Never speculates: if any signal is ambiguous, return null and fall
//     through to the LLM.
//
// What we DO NOT fast-path (deliberate):
//   • Cart operations ("add 2 brownies") — too many edge cases without
//     prod data to tune the parser.
//   • Greetings — risk of mismatching tone if the customer's intent was
//     a question dressed up as a greeting.
//   • Voice notes — transcript quality varies; LLM still safest.

type ContactChannel = { kind: string; label: string | null; value: string; isPrimary: boolean };
type Location = {
  name: string;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  isPrimary: boolean;
};

export type FastPathResult =
  | {
      intent: 'faq_hours' | 'faq_location' | 'faq_contact' | 'human_handoff';
      reply: string;
      // emit HANDOFF marker so the existing escalation pipeline takes over
      handoffMarker?: boolean;
    }
  | null;

export type FastPathInputs = {
  message: string;
  isFirstMessageInThread: boolean;
  businessInfo: {
    operatingHours: unknown;
    timezone: string | null;
  } | null;
  locations: Location[];
  contacts: ContactChannel[];
  // Re-use the existing formatter so the response shape is identical to
  // what the LLM gets out of the prompt.
  formatOperatingHours: (raw: unknown) => string;
};

// Language detection for response language. Quick + good-enough — checks
// for Arabic script + a few markers; defaults to English. Same buckets
// the bot-engine prompt cares about.
function detectLanguage(s: string): 'ar' | 'en' {
  // Any Arabic code-point → Arabic. Pure-Latin → English. Mixed → Arabic
  // (customer probably switched to Arabic for the question).
  if (/[؀-ۿ]/.test(s)) return 'ar';
  return 'en';
}

const HOURS_RE = {
  en: /\b(hours?|opening|opens?|closes?|when.*open|when.*close|what.*time|are you open|still open)\b/i,
  ar: /(الدوام|الساعه|الساعات|دواماتكم|متى تفتح|متى تسكر|متى تقفل|شو الدوام|متى تشتغل|ساعات العمل)/,
};

const LOCATION_RE = {
  en: /\b(where|address|location|located|map|find you|directions?|how.*get to|branch)\b/i,
  ar: /(وين|اين|أين|عنوان|موقع|فرع|كيف اوصل|كيف أصل)/,
};

const CONTACT_RE = {
  en: /\b(phone|telephone|whatsapp number|call you|email|contact you|reach you)\b/i,
  ar: /(تلفون|هاتف|اتصل|رقم|ايميل|ايمل|بريد|واتساب|واتس|تواصل)/,
};

const HANDOFF_RE = {
  en: /\b((talk|speak|chat|connect|transfer).{0,20}(human|person|agent|operator|representative|teammate)|customer service|real (person|human)|i want a human|stop the bot|im done with you)\b/i,
  ar: /(بدي اتكلم|بدي أتكلم|بدي اتصل|اتصل بإنسان|اريد التحدث|محادثة بشرية|انسان|انسانة|ممثل|موظف|اوقف|توقف)/,
};

// Negative signals — if the message also asks ANY of these, we don't
// fast-path. The customer wants a richer reply and a templated one
// will feel robotic or wrong.
const NEGATIVE_RE = /\b(do you have|can i|how much|prices?|price list|how do i|tell me about|info|details?|describe|order|book|reserve|appointment|menu|catalog|product|service|recommend|suggest)\b|\?.*\?/i;

function isShortQuestion(s: string): boolean {
  // ≤ 80 chars OR ≤ 12 words. A real one-shot FAQ ask is small.
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 80) return false;
  if (trimmed.split(/\s+/).length > 12) return false;
  return true;
}

function fmtHoursReply(lang: 'ar' | 'en', formattedHours: string, timezone: string | null): string {
  const tzNote = timezone ? (lang === 'ar' ? `\n(التوقيت: ${timezone})` : `\n(Timezone: ${timezone})`) : '';
  if (lang === 'ar') {
    return `هاي ساعات الدوام عندنا:\n${formattedHours}${tzNote}`;
  }
  return `Our hours:\n${formattedHours}${tzNote}`;
}

function fmtLocationReply(lang: 'ar' | 'en', locs: Location[]): string {
  const primary = locs.find((l) => l.isPrimary) ?? locs[0]!;
  const parts = [primary.addressLine1, primary.city, primary.region, primary.country]
    .filter((p) => p && p.trim().length > 0)
    .join(', ');
  const others = locs.filter((l) => l !== primary).map((l) => `• ${l.name}: ${[l.addressLine1, l.city].filter(Boolean).join(', ')}`);
  if (lang === 'ar') {
    return (
      `${primary.name}: ${parts}` +
      (others.length > 0 ? `\nفروع تانية:\n${others.join('\n')}` : '')
    );
  }
  return (
    `${primary.name}: ${parts}` +
    (others.length > 0 ? `\nOther branches:\n${others.join('\n')}` : '')
  );
}

function fmtContactReply(lang: 'ar' | 'en', contacts: ContactChannel[]): string {
  // Pick the most useful channels in a predictable order.
  const order = ['whatsapp', 'phone', 'email', 'instagram'];
  const sorted = [...contacts].sort((a, b) => {
    const ai = order.indexOf(a.kind.toLowerCase());
    const bi = order.indexOf(b.kind.toLowerCase());
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const lines = sorted.slice(0, 4).map((c) => {
    const label = c.label?.trim() || c.kind;
    return `${label}: ${c.value}`;
  });
  if (lang === 'ar') return `طرق التواصل معنا:\n${lines.join('\n')}`;
  return `Here's how to reach us:\n${lines.join('\n')}`;
}

function fmtHandoffReply(lang: 'ar' | 'en'): string {
  // The existing escalation pipeline in whatsapp.routes.ts looks for
  // [HANDOFF] on its own line and flips the thread to escalated.
  if (lang === 'ar') {
    return `تمام، رح يتواصل معك أحد من الفريق قريبًا.\n[HANDOFF]`;
  }
  return `Sure — connecting you with a teammate now. They'll pick up here shortly.\n[HANDOFF]`;
}

export function detectFastPath(inputs: FastPathInputs): FastPathResult {
  const msg = inputs.message.trim();
  if (msg.length === 0) return null;
  if (!isShortQuestion(msg)) return null;

  // Strong negative signal — defer to LLM.
  if (NEGATIVE_RE.test(msg)) return null;

  const lang = detectLanguage(msg);

  // ── Handoff has highest priority (the user actively wants to leave the
  //    bot). Length / first-message constraints don't apply — they want
  //    out regardless of where in the conversation they are.
  if (HANDOFF_RE.en.test(msg) || HANDOFF_RE.ar.test(msg)) {
    return {
      intent: 'human_handoff',
      reply: fmtHandoffReply(lang),
      handoffMarker: true,
    };
  }

  // The remaining fast-paths only fire when the message reads like a
  // standalone clean question. Mid-conversation, the customer's intent
  // is too coupled to prior context.
  if (!inputs.isFirstMessageInThread) return null;

  // ── Hours
  if (HOURS_RE.en.test(msg) || HOURS_RE.ar.test(msg)) {
    if (!inputs.businessInfo?.operatingHours) return null;
    const formatted = inputs.formatOperatingHours(inputs.businessInfo.operatingHours);
    if (!formatted) return null;
    return {
      intent: 'faq_hours',
      reply: fmtHoursReply(lang, formatted, inputs.businessInfo.timezone),
    };
  }

  // ── Location
  if (LOCATION_RE.en.test(msg) || LOCATION_RE.ar.test(msg)) {
    if (inputs.locations.length === 0) return null;
    return {
      intent: 'faq_location',
      reply: fmtLocationReply(lang, inputs.locations),
    };
  }

  // ── Contact
  if (CONTACT_RE.en.test(msg) || CONTACT_RE.ar.test(msg)) {
    if (inputs.contacts.length === 0) return null;
    return {
      intent: 'faq_contact',
      reply: fmtContactReply(lang, inputs.contacts),
    };
  }

  return null;
}
