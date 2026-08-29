import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp } from './setup.js';

// Must match vitest.config.ts test.env.VOICE_GATEWAY_SECRET.
const GW = 'test-voice-gateway-secret';

function createLine(app: FastifyInstance, accessToken: string, name: string, phoneNumber: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/phone-integrations',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name, phoneNumber },
  });
}

describe('phone integrations', () => {
  it('CRUD with an auto-issued voice key (secret shown once, revoked on delete)', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'phone-crud');

    const created = await createLine(app, a.accessToken, 'Main reception', '+961 1 234 567');
    expect(created.statusCode).toBe(201);
    const line = (
      created.json() as {
        data: { id: string; secret: string; keyPrefix: string; phoneNumber: string; callCount: number };
      }
    ).data;
    expect(line.secret).toMatch(/^ak_live_/);
    expect(line.phoneNumber).toBe('9611234567'); // normalized: digits only
    expect(line.keyPrefix).toMatch(/^ak_live_/);
    expect(line.callCount).toBe(0);

    // The auto-issued key carries voice:config — it can read the voice config.
    const cfg = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/config',
      headers: { 'x-api-key': line.secret },
    });
    expect(cfg.statusCode).toBe(200);

    // List shows it.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/phone-integrations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect((list.json() as { data: { id: string }[] }).data.find((l) => l.id === line.id)).toBeDefined();

    // Same number in a different format = same normalized DID → 409.
    const dup = await createLine(app, a.accessToken, 'Dup', '961-1-234-567');
    expect(dup.statusCode).toBe(409);

    // Pause it.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/phone-integrations/${line.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { data: { isActive: boolean } }).data.isActive).toBe(false);

    // Delete revokes the key.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/phone-integrations/${line.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(del.statusCode).toBe(200);
    const cfgAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/config',
      headers: { 'x-api-key': line.secret },
    });
    expect(cfgAfter.statusCode).toBe(401);
  });

  it('resolves a dialed number to the tenant in gateway mode', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'phone-resolve');
    const created = await createLine(app, a.accessToken, 'Sales', '+961 3 999 888');
    const lineId = (created.json() as { data: { id: string } }).data.id;

    // Missing secret → 401.
    const noSecret = await app.inject({ method: 'GET', url: '/api/v1/voice/resolve?did=9613999888' });
    expect(noSecret.statusCode).toBe(401);

    // Wrong secret → 401.
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/resolve?did=9613999888',
      headers: { 'x-voice-gateway-secret': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    // Correct secret + a differently-formatted-but-equivalent DID → 200, the
    // server normalizes both sides identically so they match.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/resolve?did=961-3-999-888',
      headers: { 'x-voice-gateway-secret': GW },
    });
    expect(ok.statusCode).toBe(200);
    const data = (
      ok.json() as {
        data: { phoneIntegrationId: string; organizationId: string; instructions: string };
      }
    ).data;
    expect(data.phoneIntegrationId).toBe(lineId);
    expect(data.organizationId).toBe(a.orgId);
    expect(data.instructions).toContain('transfer_to_human');

    // Unknown DID → 404.
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/resolve?did=15555550000',
      headers: { 'x-voice-gateway-secret': GW },
    });
    expect(unknown.statusCode).toBe(404);

    // A paused line no longer resolves.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/phone-integrations/${lineId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { isActive: false },
    });
    const inactive = await app.inject({
      method: 'GET',
      url: '/api/v1/voice/resolve?did=961-3-999-888',
      headers: { 'x-voice-gateway-secret': GW },
    });
    expect(inactive.statusCode).toBe(404);
  });

  it('gateway lifecycle writes attribute the call to the line + org', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'phone-gw-calls');
    const created = await createLine(app, a.accessToken, 'Front desk', '+961 7 111 222');
    const lineId = (created.json() as { data: { id: string } }).data.id;
    const callUuid = 'abadbabe-0000-1111-2222-333344445566';

    // Gateway mode requires the phone-integration header → 400 without it.
    const noPid = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/calls',
      headers: { 'x-voice-gateway-secret': GW },
      payload: { callUuid },
    });
    expect(noPid.statusCode).toBe(400);

    // Bad gateway secret → 401.
    const badGw = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/calls',
      headers: { 'x-voice-gateway-secret': 'nope', 'x-phone-integration-id': lineId },
      payload: { callUuid },
    });
    expect(badGw.statusCode).toBe(401);

    // Valid gateway start → 201.
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/calls',
      headers: { 'x-voice-gateway-secret': GW, 'x-phone-integration-id': lineId },
      payload: { callUuid, callerId: '+9613000111', dialedExten: '9617111222' },
    });
    expect(start.statusCode).toBe(201);

    // The call is attributed to the line (per-line filter returns it).
    const lineCalls = await app.inject({
      method: 'GET',
      url: `/api/v1/voice/calls?phoneIntegrationId=${lineId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(lineCalls.statusCode).toBe(200);
    expect(
      (lineCalls.json() as { data: { callUuid: string }[] }).data.find((c) => c.callUuid === callUuid),
    ).toBeDefined();

    // …and the line's recency + count are stamped.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/phone-integrations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const line = (
      list.json() as { data: { id: string; callCount: number; lastCallAt: string | null }[] }
    ).data.find((l) => l.id === lineId)!;
    expect(line.callCount).toBe(1);
    expect(line.lastCallAt).not.toBeNull();
  });

  it('api-key lifecycle attributes the call to the line that owns the key', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'phone-key-attr');
    const created = await createLine(app, a.accessToken, 'Dedicated line', '+961 8 555 444');
    const { id: lineId, secret } = (created.json() as { data: { id: string; secret: string } }).data;
    const callUuid = 'cafed00d-0000-1111-2222-333344445599';

    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/calls',
      headers: { 'x-api-key': secret },
      payload: { callUuid },
    });
    expect(start.statusCode).toBe(201);

    const lineCalls = await app.inject({
      method: 'GET',
      url: `/api/v1/voice/calls?phoneIntegrationId=${lineId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(
      (lineCalls.json() as { data: { callUuid: string }[] }).data.find((c) => c.callUuid === callUuid),
    ).toBeDefined();
  });
});
