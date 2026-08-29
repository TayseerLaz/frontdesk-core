// Unit tests for the Phase 9 reply-validators pipeline.
import { describe, expect, it } from 'vitest';

import {
  validateReply,
  type ValidationContext,
} from '../src/lib/reply-validators.js';

function makeCtx(over: Partial<ValidationContext> = {}): ValidationContext {
  return {
    reply: '',
    userMessage: '',
    inputs: {
      systemPrompt: '',
      userPrompt: '',
      historyJson: [],
      candidateProductIds: [],
      candidateServiceIds: [],
      candidateFaqIds: [],
      candidatePolicyKinds: [],
      businessInfoFields: [],
      model: 'gpt-4o-mini',
      temperature: 0.4,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 0,
    },
    kb: {
      products: [
        { id: 'p1', name: 'Oreo Milkshake', sku: 'ATK-OREO', priceMinor: 150, currency: 'KWD' },
      ],
      services: [],
      faqs: [],
      policies: [],
      biz: {
        legalName: 'Aseer Time',
        websiteUrl: null,
        operatingHours: null,
        currency: 'KWD',
        menuUrl: null,
      },
      config: { greeting: '👋 Welcome to Aseer Time !!' },
      customer: { whatsappName: 'Tayseer', operatorNickname: null },
    },
    cartDraft: null,
    bookingFormEnabled: false,
    shopFormEnabled: false,
    voiceMode: 'text',
    previousBotReply: null,
    configuredGreeting: '👋 Welcome to Aseer Time !!',
    ...over,
  };
}

describe('validateReply — image markers', () => {
  it('drops [IMAGE: <SKU>] when the SKU is not in the candidate set', () => {
    const out = validateReply(
      makeCtx({
        reply: 'Here you go!\n[IMAGE: ATK-WRONG-SKU]',
      }),
    );
    expect(out.reply).not.toContain('ATK-WRONG-SKU');
    expect(out.warnings.find((w) => w.category === 'image_marker_unknown_sku')).toBeDefined();
  });

  it('keeps [IMAGE: <SKU>] when the SKU IS in the candidate set', () => {
    const out = validateReply(
      makeCtx({
        reply: 'Here you go!\n[IMAGE: ATK-OREO]',
      }),
    );
    expect(out.reply).toContain('[IMAGE: ATK-OREO]');
    expect(out.warnings.filter((w) => w.category === 'image_marker_unknown_sku')).toHaveLength(0);
  });

  it('is case-insensitive on SKU comparison', () => {
    const out = validateReply(
      makeCtx({ reply: '[IMAGE: atk-oreo]' }),
    );
    expect(out.reply).toContain('[IMAGE: atk-oreo]');
  });
});

describe('validateReply — voice apologies', () => {
  it('strips "I can\'t send voice notes" sentences', () => {
    const out = validateReply(
      makeCtx({
        reply: "I can't send voice notes, but I'm here to help you through text! Just let me know what you need.",
        voiceMode: 'voice',
      }),
    );
    expect(out.reply.toLowerCase()).not.toContain("can't send voice");
    expect(out.warnings.find((w) => w.category === 'voice_capability_apology')).toBeDefined();
  });

  it('strips "I\'m just a text chatbot" phrasings', () => {
    const out = validateReply(
      makeCtx({
        reply: "I'm just a text chatbot, but here's what I can help with.",
      }),
    );
    expect(out.reply.toLowerCase()).not.toContain('text chatbot');
  });

  it('strips Arabic apology phrasings', () => {
    const out = validateReply(
      makeCtx({
        reply: 'آسف، لا أستطيع إرسال صوت. لكن يمكنني مساعدتك في النص.',
      }),
    );
    expect(out.reply).not.toMatch(/لا أستطيع إرسال صوت/);
  });

  it('leaves legitimate "voice note" mentions alone', () => {
    const out = validateReply(
      makeCtx({
        reply: 'I noticed you sent a voice note. What would you like help with?',
      }),
    );
    expect(out.reply).toContain('voice note');
    expect(out.warnings.filter((w) => w.category === 'voice_capability_apology')).toHaveLength(0);
  });
});

describe('validateReply — cart total injection', () => {
  it('injects the computed total when bot demurred + customer asked for total', () => {
    const out = validateReply(
      makeCtx({
        userMessage: "Whats the total price?",
        reply: "I can't provide the total price right now.",
        cartDraft: {
          items: [
            { name: 'Oreo Milkshake', sku: 'ATK-OREO', quantity: 3, unitPriceMinor: 150 },
          ],
          totalMinor: 450,
          currency: 'KWD',
        },
      }),
    );
    expect(out.reply).toContain('0.450 KWD');
    expect(out.warnings.find((w) => w.category === 'cart_total_demur')).toBeDefined();
  });

  it('does NOT inject when cart is empty', () => {
    const out = validateReply(
      makeCtx({
        userMessage: "Whats the total?",
        reply: "I can't provide the total right now.",
        cartDraft: null,
      }),
    );
    expect(out.reply).not.toContain('KWD');
  });
});

describe('validateReply — booking fidelity', () => {
  it('replaces "session is booked" when no [BOOKING:] marker emitted', () => {
    const out = validateReply(
      makeCtx({
        reply: "Great! Your IT Strategy Consulting session is booked for tomorrow at 5 PM.",
        bookingFormEnabled: true,
      }),
    );
    expect(out.reply.toLowerCase()).not.toContain('session is booked');
    expect(out.reply.toLowerCase()).toContain('confirm');
    expect(out.warnings.find((w) => w.category === 'booking_confirmation_without_marker')).toBeDefined();
  });

  it('leaves it alone when the [BOOKING:] marker IS emitted', () => {
    const out = validateReply(
      makeCtx({
        reply: 'Your booking is confirmed!\n[BOOKING: {"name":"Tayseer"}]',
        bookingFormEnabled: true,
      }),
    );
    expect(out.reply).toContain('booking is confirmed');
    expect(out.warnings.filter((w) => w.category === 'booking_confirmation_without_marker')).toHaveLength(0);
  });

  it('does nothing when the booking form isn\'t enabled', () => {
    const out = validateReply(
      makeCtx({
        reply: 'Your session is booked for tomorrow.',
        bookingFormEnabled: false,
      }),
    );
    expect(out.reply).toContain('session is booked');
  });
});

describe('validateReply — handoff strictness', () => {
  it('strips [HANDOFF] when user message looks like a reset', () => {
    const out = validateReply(
      makeCtx({
        userMessage: 'reset convo',
        reply: 'Sure — connecting you with a teammate now.\n[HANDOFF]',
      }),
    );
    expect(out.reply).not.toContain('[HANDOFF]');
    expect(out.warnings.find((w) => w.category === 'handoff_false_positive')).toBeDefined();
  });

  it('keeps [HANDOFF] when user explicitly asks for a human', () => {
    const out = validateReply(
      makeCtx({
        userMessage: 'I want to talk to a human',
        reply: 'Got it, connecting you now.\n[HANDOFF]',
      }),
    );
    expect(out.reply).toContain('[HANDOFF]');
  });

  it('keeps [HANDOFF] when user asks for "customer service"', () => {
    const out = validateReply(
      makeCtx({
        userMessage: 'can I talk to customer service please',
        reply: '[HANDOFF]',
      }),
    );
    expect(out.reply).toContain('[HANDOFF]');
  });

  it('strips [HANDOFF] on generic "speak to" without a person noun', () => {
    const out = validateReply(
      makeCtx({
        userMessage: 'can I speak to about pricing',
        reply: '[HANDOFF]',
      }),
    );
    expect(out.reply).not.toContain('[HANDOFF]');
  });
});

describe('validateReply — currency subunits', () => {
  it('rewrites "150 fils" to "0.150 KWD" when biz currency is KWD', () => {
    const out = validateReply(
      makeCtx({
        reply: 'The Oreo Milkshake is 150 fils.',
      }),
    );
    expect(out.reply).toContain('0.150 KWD');
    expect(out.reply).not.toMatch(/fils/i);
    expect(out.warnings.find((w) => w.category === 'currency_subunit_conversion')).toBeDefined();
  });

  it('rewrites "50 cents" to "0.50 USD" when biz currency is USD', () => {
    const out = validateReply(
      makeCtx({
        kb: {
          products: [],
          services: [],
          faqs: [],
          policies: [],
          biz: { legalName: null, websiteUrl: null, operatingHours: null, currency: 'USD', menuUrl: null },
          config: null,
          customer: null,
        },
        reply: 'Service charge is 50 cents.',
      }),
    );
    expect(out.reply).toContain('0.50 USD');
    expect(out.reply).not.toMatch(/cents/i);
  });

  it('rewrites "75 halala" to "0.75 SAR" when biz currency is SAR', () => {
    const out = validateReply(
      makeCtx({
        kb: {
          products: [],
          services: [],
          faqs: [],
          policies: [],
          biz: { legalName: null, websiteUrl: null, operatingHours: null, currency: 'SAR', menuUrl: null },
          config: null,
          customer: null,
        },
        reply: 'It costs 75 halala.',
      }),
    );
    expect(out.reply).toContain('0.75 SAR');
  });

  it('rewrites Arabic "150 فلس" to "0.150 KWD"', () => {
    const out = validateReply(
      makeCtx({
        reply: 'سعرها 150 فلس فقط.',
      }),
    );
    expect(out.reply).toContain('0.150 KWD');
    expect(out.reply).not.toMatch(/فلس/);
  });

  it('does NOT touch already-formatted "0.150 KWD" prices', () => {
    const out = validateReply(
      makeCtx({
        reply: 'The Oreo Milkshake is 0.150 KWD.',
      }),
    );
    expect(out.reply).toBe('The Oreo Milkshake is 0.150 KWD.');
  });
});

describe('validateReply — welcome dedup', () => {
  it('replaces a repeat welcome with a soft continuation', () => {
    const out = validateReply(
      makeCtx({
        reply: '👋 Welcome to Aseer Time !! How can I help you today?',
        previousBotReply: '👋 Welcome to Aseer Time !! How can I assist you today?',
        configuredGreeting: '👋 Welcome to Aseer Time !!',
      }),
    );
    expect(out.reply.toLowerCase()).not.toContain('welcome to aseer time');
    expect(out.warnings.find((w) => w.category === 'welcome_repeat')).toBeDefined();
  });

  it('does NOT dedup when previous reply was something else', () => {
    const out = validateReply(
      makeCtx({
        reply: '👋 Welcome to Aseer Time !! How can I help you today?',
        previousBotReply: 'Your order is on the way.',
        configuredGreeting: '👋 Welcome to Aseer Time !!',
      }),
    );
    expect(out.reply).toContain('Welcome to Aseer Time');
  });
});

describe('validateReply — multiple validators chained', () => {
  it('runs all six steps in order; warnings stack up', () => {
    const out = validateReply(
      makeCtx({
        userMessage: 'reset convo',
        reply:
          "I can't send voice notes.\nYour appointment is booked for tomorrow.\n[IMAGE: BAD-SKU]\n[HANDOFF]",
        bookingFormEnabled: true,
      }),
    );
    // Voice apology stripped + image marker dropped + handoff stripped +
    // booking phrase replaced with re-confirm question.
    expect(out.reply.toLowerCase()).not.toContain("can't send voice");
    expect(out.reply).not.toContain('BAD-SKU');
    expect(out.reply).not.toContain('[HANDOFF]');
    expect(out.reply.toLowerCase()).toContain('confirm');
    expect(out.warnings.length).toBeGreaterThanOrEqual(3);
  });
});
