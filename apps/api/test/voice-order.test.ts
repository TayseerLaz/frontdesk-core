import { describe, expect, it } from 'vitest';

import { hashToken } from '../src/lib/crypto.js';
import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

// Exercises the voice order/booking/caller-continuity paths end-to-end through
// the Fastify routes (no mocks) — the fixes for the "forms not captured / address
// in the wrong place / empty fields" report plus phone bookings + caller memory.

async function bypass() {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
}

async function issueKey(orgId: string, userId: string, salt: string, scopes = ['voice:config', 'voice:calls']) {
  const secret = `ak_live_vo_${salt}_${'x'.repeat(12)}`;
  await bypass();
  await prisma.apiKey.create({
    data: {
      organizationId: orgId,
      name: `voice-order-test-${salt}`,
      prefix: secret.slice(0, 24),
      keyHash: hashToken(secret),
      scopes,
      createdById: userId,
    },
  });
  return secret;
}

// Configure a shop form with three custom fields (the exact shape that broke:
// answers must land under delivery_address / payment / anything_else, NOT a
// synthetic notes blob).
async function enableShop(
  orgId: string,
  opts: { minOrderMinor?: number | null; requireAddress?: boolean } = {},
) {
  await bypass();
  await prisma.businessInfo.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      currency: 'USD',
      shopForm: shopFormJson(opts),
    },
    update: { currency: 'USD', shopForm: shopFormJson(opts) },
  });
}

function shopFormJson(opts: { minOrderMinor?: number | null; requireAddress?: boolean }) {
  return {
    enabled: true,
    title: 'Order',
    intentKeywords: ['order'],
    fields: [
      { key: 'delivery_address', label: 'Delivery address', type: 'text', required: opts.requireAddress === true },
      { key: 'payment', label: 'Payment', type: 'text', required: false },
      { key: 'anything_else', label: 'Anything else?', type: 'text', required: false },
    ],
    minOrderMinor: opts.minOrderMinor ?? null,
    deliveryFeeMinor: null,
    freeDeliveryAboveMinor: null,
    confirmationMessage: 'Thanks!',
  };
}

async function enableBooking(orgId: string) {
  await bypass();
  await prisma.businessInfo.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      currency: 'USD',
      bookingForm: {
        enabled: true,
        title: 'Appointment',
        intentKeywords: ['book'],
        fields: [
          { key: 'name', label: 'Full name', type: 'text', required: true },
          { key: 'date', label: 'Date and time', type: 'date', required: true },
        ],
      },
    },
    update: {
      currency: 'USD',
      bookingForm: {
        enabled: true,
        title: 'Appointment',
        intentKeywords: ['book'],
        fields: [
          { key: 'name', label: 'Full name', type: 'text', required: true },
          { key: 'date', label: 'Date and time', type: 'date', required: true },
        ],
      },
    },
  });
}

async function addProduct(accessToken: string, name: string, sku: string, priceMinor: number) {
  const app = getApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { sku, name, priceMinor, currency: 'USD', isAvailable: true },
  });
  expect(res.statusCode).toBeLessThan(300);
}

function uuid(n: number) {
  const h = n.toString(16).padStart(2, '0');
  return `deadbeef-cafe-f00d-aaaa-0123456789${h}`;
}

async function startCall(key: string, callUuid: string, callerId: string | null) {
  const app = getApp();
  return app.inject({
    method: 'POST',
    url: '/api/v1/voice/calls',
    headers: { 'x-api-key': key },
    payload: { callUuid, callerId },
  });
}

describe('voice order capture (field fidelity + safety)', () => {
  it('persists configured shopForm field answers (not a synthetic notes blob) + channel/callUuid', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vordfields');
    const key = await issueKey(a.orgId, a.userId, 'fields');
    await enableShop(a.orgId);
    await addProduct(a.accessToken, 'Mozzarella Cubes', 'MOZ-1', 360000);
    const callUuid = uuid(1);
    await startCall(key, callUuid, '+9613111111');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: {
        items: [{ name: 'mozzarella cubes', quantity: 5 }],
        customerName: 'Layth',
        phone: '+9613111111',
        fields: { delivery_address: 'الأشرفية', payment: 'cash', anything_else: 'extra sauce' },
      },
    });
    expect(res.statusCode).toBe(200);
    const orderId = (res.json() as { data: { orderId: string } }).data.orderId;

    await bypass();
    const cart = await prisma.cart.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    expect(cart).toBeTruthy();
    expect(cart!.channel).toBe('voice');
    expect(cart!.callUuid).toBe(callUuid);
    // The address must be in the configured field — NOT a synthetic note.
    expect(cart!.notes).toBeNull();
    const fields = cart!.fields as { key: string; value: string | null }[];
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(byKey.delivery_address).toBe('الأشرفية');
    expect(byKey.payment).toBe('cash');
    expect(byKey.anything_else).toBe('extra sauce');
    expect(Number(cart!.items[0]!.unitPriceMinor)).toBe(360000);
    expect(cart!.items[0]!.needsPricing).toBe(false);
  });

  it('is idempotent on retry (same callUuid → one cart, merged=true)', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vordidem');
    const key = await issueKey(a.orgId, a.userId, 'idem');
    await enableShop(a.orgId);
    await addProduct(a.accessToken, 'Soft Drink', 'SD-1', 120000);
    const callUuid = uuid(2);
    await startCall(key, callUuid, '+9613222222');
    const payload = {
      method: 'POST' as const,
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'soft drink', quantity: 2 }], phone: '+9613222222', fields: {} },
    };
    const first = await app.inject(payload);
    const second = await app.inject(payload);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { data: { merged: boolean } }).data.merged).toBe(true);
    await bypass();
    const count = await prisma.cart.count({ where: { organizationId: a.orgId, callUuid } });
    expect(count).toBe(1);
  });

  it('flags unmatched spoken items needsPricing at price 0', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vordunm');
    const key = await issueKey(a.orgId, a.userId, 'unm');
    await enableShop(a.orgId);
    await addProduct(a.accessToken, 'Falafel Wrap', 'FW-1', 200000);
    const callUuid = uuid(3);
    await startCall(key, callUuid, '+9613333333');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'unicorn smoothie', quantity: 1 }], phone: '+9613333333', fields: {} },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { unmatched: string[] } }).data.unmatched).toContain('unicorn smoothie');
    await bypass();
    const item = await prisma.cartItem.findFirst({ where: { organizationId: a.orgId } });
    expect(item!.needsPricing).toBe(true);
    expect(Number(item!.unitPriceMinor)).toBe(0);
  });

  it('withheld/anonymous caller gets a per-call placeholder, never an empty phone', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vordwith');
    const key = await issueKey(a.orgId, a.userId, 'with');
    await enableShop(a.orgId);
    await addProduct(a.accessToken, 'Lemonade', 'LM-1', 90000);
    const callUuid = uuid(4);
    await startCall(key, callUuid, 'anonymous');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'lemonade', quantity: 1 }], fields: {} },
    });
    expect(res.statusCode).toBe(200);
    await bypass();
    const cart = await prisma.cart.findFirst({ where: { organizationId: a.orgId, callUuid } });
    expect(cart!.customerPhone.startsWith('voice_')).toBe(true);
  });

  it('enforces minimum order + required fields server-side (400, not an unfulfillable order)', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vordmin');
    const key = await issueKey(a.orgId, a.userId, 'min');
    await enableShop(a.orgId, { minOrderMinor: 1000000, requireAddress: true });
    await addProduct(a.accessToken, 'Cookie', 'CK-1', 50000);
    const callUuid = uuid(5);
    await startCall(key, callUuid, '+9613555555');
    // Below minimum.
    const belowMin = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'cookie', quantity: 1 }], phone: '+9613555555', fields: { delivery_address: 'x' } },
    });
    expect(belowMin.statusCode).toBe(400);
    // Missing required address.
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'cookie', quantity: 30 }], phone: '+9613555555', fields: {} },
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('voice booking capture', () => {
  it('creates a voice-channel Booking linked to its call', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vbook');
    const key = await issueKey(a.orgId, a.userId, 'book');
    await enableBooking(a.orgId);
    const callUuid = uuid(6);
    await startCall(key, callUuid, '+9613666666');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/booking`,
      headers: { 'x-api-key': key },
      payload: { fields: { name: 'Jana', date: 'June 30, 2026 5:00 PM' }, phone: '+9613666666' },
    });
    expect(res.statusCode).toBe(200);
    const bookingId = (res.json() as { data: { bookingId: string } }).data.bookingId;
    await bypass();
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking!.channel).toBe('voice');
    expect(booking!.callUuid).toBe(callUuid);
    expect(booking!.customerPhone).toBe('9613666666');
  });

  it('400s when bookings are not enabled', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vbooknone');
    const key = await issueKey(a.orgId, a.userId, 'booknone');
    const callUuid = uuid(7);
    await startCall(key, callUuid, '+9613777777');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/booking`,
      headers: { 'x-api-key': key },
      payload: { fields: { name: 'x' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('voice caller continuity + compliance', () => {
  it('surfaces a returning caller’s open order via caller-context', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vctx');
    const key = await issueKey(a.orgId, a.userId, 'ctx');
    await enableShop(a.orgId);
    await addProduct(a.accessToken, 'Burger', 'BG-1', 500000);
    const callUuid = uuid(8);
    await startCall(key, callUuid, '+9613888888');
    await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/order`,
      headers: { 'x-api-key': key },
      payload: { items: [{ name: 'burger', quantity: 1 }], customerName: 'Sami', phone: '+9613888888', fields: {} },
    });
    const ctx = await app.inject({
      method: 'GET',
      url: `/api/v1/voice/caller-context?phone=${encodeURIComponent('+9613888888')}`,
      headers: { 'x-api-key': key },
    });
    expect(ctx.statusCode).toBe(200);
    const data = (ctx.json() as { data: { known: boolean; name: string | null; openOrder: { itemsSummary: string } | null } }).data;
    expect(data.known).toBe(true);
    expect(data.openOrder).toBeTruthy();
    expect(data.openOrder!.itemsSummary).toContain('Burger');
  });

  it('upserts a Contact on call start and honours a spoken STOP at call end', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'vstop');
    const key = await issueKey(a.orgId, a.userId, 'stop');
    const callUuid = uuid(9);
    await startCall(key, callUuid, '+9613999999');
    // Caller says "stop" → opt-out on call end.
    await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/turns`,
      headers: { 'x-api-key': key },
      payload: { turns: [{ seq: 0, role: 'caller', text: 'stop' }] },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${callUuid}/end`,
      headers: { 'x-api-key': key },
      payload: { outcome: 'completed' },
    });
    await bypass();
    const contact = await prisma.contact.findFirst({
      where: { organizationId: a.orgId, phoneE164: '9613999999' },
    });
    expect(contact).toBeTruthy();
    expect(contact!.channel).toBe('voice');
    expect(contact!.optedOutAt).not.toBeNull();
  });
});
