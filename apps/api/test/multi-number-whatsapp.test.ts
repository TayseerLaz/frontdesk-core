// Multi-number WhatsApp: per-number channels, the bot toggle, per-number thread
// dedup (the partial unique indexes), and the inbox per-number filter.
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('multi-number WhatsApp', () => {
  it('manages numbers: list, add, label, bot toggle, primary', async () => {
    const app = getApp();
    const s = await seedOrgAndLogin(app, 'mnwa1');
    const auth = { authorization: `Bearer ${s.accessToken}` };

    // GET /whatsapp lazily creates the primary stub.
    const first = await app.inject({ method: 'GET', url: '/api/v1/whatsapp', headers: auth });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { data: { isPrimary: boolean } }).data.isPrimary).toBe(true);

    // Add a second number.
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/whatsapp/numbers',
      headers: auth,
      payload: { label: 'Support line' },
    });
    expect(add.statusCode).toBe(200);
    const secondId = (add.json() as { data: { id: string } }).data.id;

    // List shows both, primary first.
    const list = await app.inject({ method: 'GET', url: '/api/v1/whatsapp/numbers', headers: auth });
    const rows = (list.json() as { data: { id: string; isPrimary: boolean; botEnabled: boolean }[] }).data;
    expect(rows.length).toBe(2);
    expect(rows[0]!.isPrimary).toBe(true);

    // Turn the bot ON for the second number + set its label.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/whatsapp/numbers/${secondId}`,
      headers: auth,
      payload: { botEnabled: true, label: 'Renamed' },
    });
    expect(put.statusCode).toBe(200);
    const updated = (put.json() as { data: { botEnabled: boolean; label: string } }).data;
    expect(updated.botEnabled).toBe(true);
    expect(updated.label).toBe('Renamed');

    // Promote the second number to primary.
    const promote = await app.inject({
      method: 'POST',
      url: `/api/v1/whatsapp/numbers/${secondId}/promote`,
      headers: auth,
    });
    expect(promote.statusCode).toBe(200);
    const after = (
      (await app.inject({ method: 'GET', url: '/api/v1/whatsapp/numbers', headers: auth })).json() as {
        data: { id: string; isPrimary: boolean }[];
      }
    ).data;
    expect(after.find((r) => r.id === secondId)!.isPrimary).toBe(true);
    expect(after.filter((r) => r.isPrimary).length).toBe(1);
  });

  it('keeps a separate thread per number for the same customer and filters by number', async () => {
    const app = getApp();
    const s = await seedOrgAndLogin(app, 'mnwa2');
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

    // Two channels for the org.
    const chA = await prisma.whatsAppChannel.create({
      data: { organizationId: s.orgId, isPrimary: true, label: 'A', webhookVerifyToken: 'va' },
    });
    const chB = await prisma.whatsAppChannel.create({
      data: { organizationId: s.orgId, isPrimary: false, label: 'B', webhookVerifyToken: 'vb' },
    });

    // SAME customer phone, but two different numbers → two distinct threads.
    const phone = '15551234567';
    const tA = await prisma.whatsAppThread.create({
      data: { organizationId: s.orgId, customerPhone: phone, whatsAppChannelId: chA.id },
    });
    const tB = await prisma.whatsAppThread.create({
      data: { organizationId: s.orgId, customerPhone: phone, whatsAppChannelId: chB.id },
    });
    expect(tA.id).not.toBe(tB.id);

    // Inserting a third with the SAME (org, phone, channel) as A must violate
    // the partial unique index.
    await expect(
      prisma.whatsAppThread.create({
        data: { organizationId: s.orgId, customerPhone: phone, whatsAppChannelId: chA.id },
      }),
    ).rejects.toThrow();

    // The inbox filter returns only the requested number's thread.
    const auth = { authorization: `Bearer ${s.accessToken}` };
    const onlyA = await app.inject({
      method: 'GET',
      url: `/api/v1/inbox/threads?channel=whatsapp&whatsAppChannelId=${chA.id}`,
      headers: auth,
    });
    const aRows = (onlyA.json() as { data: { id: string; whatsAppChannelId: string; whatsAppChannelLabel: string }[] }).data;
    expect(aRows.map((r) => r.id)).toEqual([tA.id]);
    expect(aRows[0]!.whatsAppChannelLabel).toBe('A');
  });
});
