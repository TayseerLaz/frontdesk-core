import { describe, expect, it } from 'vitest';

import { hashToken } from '../src/lib/crypto.js';
import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

// Dashed-lowercase AudioSocket call UUID (SHA1-derived, not RFC 4122).
const CALL_UUID = 'deadbeef-cafe-f00d-aaaa-0123456789ab';

async function issueKey(orgId: string, userId: string, scopes: string[], salt: string) {
  const secret = `ak_live_voice_${salt}_${'x'.repeat(12)}`;
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  await prisma.apiKey.create({
    data: {
      organizationId: orgId,
      name: `voice-test-${salt}`,
      // Wide enough to keep the salt in the (unique) prefix when a test
      // issues two keys.
      prefix: secret.slice(0, 24),
      keyHash: hashToken(secret),
      scopes,
      createdById: userId,
    },
  });
  return secret;
}

describe('voice media gateway API', () => {
  it('serves compiled voice config gated by voice:config scope', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'voicecfga');
    const key = await issueKey(a.orgId, a.userId, ['voice:config'], 'cfg');
    const readOnlyKey = await issueKey(a.orgId, a.userId, ['read:catalog'], 'cfgro');

    // Give the org one product so the grounding section is non-trivial.
    await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { sku: 'VOICE-1', name: 'Voice Test Juice', priceMinor: 1500, currency: 'KWD', isAvailable: true },
    });

    // No key — 401.
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/voice/config' });
    expect(unauth.statusCode).toBe(401);

    // Wrong scope — 403.
    const wrongScope = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/config',
      headers: { 'x-api-key': readOnlyKey },
    });
    expect(wrongScope.statusCode).toBe(403);

    // Correct scope — 200 with instructions grounded in tenant data.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/config',
      headers: { 'x-api-key': key },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { data: { instructions: string; languages: string } };
    expect(body.data.instructions).toContain('transfer_to_human');
    expect(body.data.instructions).toContain('Voice Test Juice');
    expect(body.data.languages.length).toBeGreaterThan(0);
  });

  it('ingests call lifecycle + turns idempotently and tenant-scoped', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'voicecalla');
    const b = await seedOrgAndLogin(app, 'voicecallb');
    const keyA = await issueKey(a.orgId, a.userId, ['voice:calls'], 'calla');

    // Start the call twice — second is an idempotent upsert, not a 500.
    for (let i = 0; i < 2; i++) {
      const start = await app.inject({
        method: 'POST',
        url: '/api/v1/voice/calls',
        headers: { 'x-api-key': keyA },
        payload: { callUuid: CALL_UUID, callerId: '+96170123456', dialedExten: '1' },
      });
      expect(start.statusCode).toBe(201);
    }

    // Append transcript turns.
    const turns = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${CALL_UUID}/turns`,
      headers: { 'x-api-key': keyA },
      payload: {
        turns: [
          { seq: 0, role: 'assistant', text: 'Hello, how can I help you today?' },
          { seq: 1, role: 'caller', text: 'What time do you close?' },
        ],
      },
    });
    expect(turns.statusCode).toBe(200);
    expect((turns.json() as { data: { appended: number } }).data.appended).toBe(2);

    // Retried identical batch (committed first attempt, lost response) is a
    // no-op — idempotent via the (voiceCallId, seq) unique + skipDuplicates.
    const turnsRetry = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${CALL_UUID}/turns`,
      headers: { 'x-api-key': keyA },
      payload: {
        turns: [
          { seq: 0, role: 'assistant', text: 'Hello, how can I help you today?' },
          { seq: 1, role: 'caller', text: 'What time do you close?' },
        ],
      },
    });
    expect(turnsRetry.statusCode).toBe(200);
    expect((turnsRetry.json() as { data: { appended: number } }).data.appended).toBe(0);

    // End with a handoff outcome.
    const end = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${CALL_UUID}/end`,
      headers: { 'x-api-key': keyA },
      payload: { outcome: 'handoff', reason: 'caller asked for a human' },
    });
    expect(end.statusCode).toBe(200);

    // Ended calls are immutable: a replayed/hostile end is a 200 no-op that
    // does NOT flip the recorded outcome.
    const endAgain = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${CALL_UUID}/end`,
      headers: { 'x-api-key': keyA },
      payload: { outcome: 'completed', reason: 'overwrite attempt' },
    });
    expect(endAgain.statusCode).toBe(200);

    // Portal list shows the call for org A…
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/calls',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const calls = (list.json() as { data: { callUuid: string; outcome: string; turnCount: number; id: string }[] }).data;
    const call = calls.find((c) => c.callUuid === CALL_UUID);
    expect(call).toBeDefined();
    expect(call!.outcome).toBe('handoff');
    expect(call!.turnCount).toBe(2);

    // …with the transcript in the detail view…
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/voice/calls/${call!.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const turnsBody = (detail.json() as { data: { turns: { role: string; text: string }[] } }).data.turns;
    expect(turnsBody).toHaveLength(2);
    expect(turnsBody[1]!.text).toContain('close');

    // …and org B sees nothing (tenant isolation).
    const listB = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/calls',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(listB.statusCode).toBe(200);
    expect((listB.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it('materializes the call row when turns arrive before the start event', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'voicelate');
    const key = await issueKey(a.orgId, a.userId, ['voice:calls'], 'late');
    const lateUuid = 'feedface-0000-1111-2222-333344445555';

    const turns = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/calls/${lateUuid}/turns`,
      headers: { 'x-api-key': key },
      payload: { turns: [{ seq: 0, role: 'caller', text: 'hello?' }] },
    });
    expect(turns.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/calls',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const calls = (list.json() as { data: { callUuid: string; outcome: string }[] }).data;
    expect(calls.find((c) => c.callUuid === lateUuid)?.outcome).toBe('in_progress');
  });
});
