// Lightweight intent classifier for the ultra plan. A cheap Haiku pass
// (via completeFast) decides what the customer is trying to do, so the
// orchestration layer can route deterministically — which link to send,
// whether this is an order vs a booking. The model ASSISTS; the caller
// DECIDES. Per the bot-engine lesson that soft prompt directives get
// ignored, intent has to be an explicit signal, not a wish in the prompt.

import { completeFast } from './openai.js';

export type BotIntent =
  | 'order' // wants to buy a product / place or track an order
  | 'booking' // wants to book/schedule a service or appointment
  | 'question' // general info: hours, location, price, product Q&A
  | 'support' // complaint / problem with an existing order or booking
  | 'smalltalk' // greeting / chit-chat
  | 'other';

export interface IntentResult {
  intent: BotIntent;
  // 0..1 — caller can require a threshold before acting deterministically.
  confidence: number;
  // Free-form one-line reason, for logs / provenance.
  reason: string;
}

const VALID: BotIntent[] = ['order', 'booking', 'question', 'support', 'smalltalk', 'other'];

export async function classifyIntent(args: {
  organizationId: string;
  userMessage: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  // Tell the classifier what the business actually offers so it doesn't
  // guess "booking" for a shop with no services, etc.
  offers?: {
    hasProducts: boolean;
    hasServices: boolean;
    hasBookingForm: boolean;
    hasShopForm: boolean;
  };
}): Promise<IntentResult> {
  const recent = (args.history ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n')
    .slice(0, 1500);

  const offers = args.offers;
  const offerHint = offers
    ? `Business offers — products: ${offers.hasProducts}, services: ${offers.hasServices}, booking flow: ${offers.hasBookingForm}, shop/order flow: ${offers.hasShopForm}.`
    : '';

  const sys = [
    "Classify the customer's latest message into exactly one intent for a business WhatsApp chatbot.",
    'Intents: "order" (buy a product / place or track an order), "booking" (book/schedule a service or appointment), "question" (general info: hours, location, price, product Q&A), "support" (problem/complaint about an existing order or booking), "smalltalk" (greeting/chit-chat), "other".',
    offerHint,
    'Messages may be in Arabic (including dialects), English, or French, and may contain typos — classify by meaning, not keywords.',
    'Return JSON only: {"intent": string, "confidence": number between 0 and 1, "reason": string}.',
  ]
    .filter(Boolean)
    .join(' ');

  const user = `${recent ? `Recent conversation:\n${recent}\n\n` : ''}Latest customer message:\n${args.userMessage}`;

  try {
    const r = await completeFast<{ intent?: string; confidence?: number; reason?: string }>({
      organizationId: args.organizationId,
      systemPrompt: sys,
      userContent: user,
      maxTokens: 120,
    });
    const intent = (VALID as string[]).includes(r.intent ?? '') ? (r.intent as BotIntent) : 'other';
    const confidence =
      typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    return { intent, confidence, reason: (r.reason ?? '').slice(0, 200) };
  } catch {
    // On any failure stay neutral — the reply still happens; we just lose
    // deterministic routing for this turn.
    return { intent: 'other', confidence: 0, reason: 'classifier unavailable' };
  }
}
