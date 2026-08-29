// Phase 4 — Broadcast lifecycle integration test.
// Covers: create draft → set up audience (manual) → cancel.
// Send is exercised separately via the worker (real Meta calls would be
// flaky in CI; this test stops at the queue boundary).
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

async function createApprovedTemplate(orgId: string): Promise<string> {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  const t = await prisma.whatsAppTemplate.create({
    data: {
      organizationId: orgId,
      name: `tpl_${Date.now()}`,
      language: 'en_US',
      category: 'MARKETING',
      bodyText: 'Hello {{1}}',
      status: 'approved',
    },
  });
  return t.id;
}

async function ensureChannel(orgId: string): Promise<string> {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  const c = await prisma.whatsAppChannel.upsert({
    where: { id: orgId }, // not real but we'll just create one
    create: {
      organizationId: orgId,
      isPrimary: true,
      webhookVerifyToken: 'test',
      accessToken: 'test_token',
      phoneNumberId: '12345',
      isActive: true,
    },
    update: {},
  }).catch(async () => {
    // primary key won't match orgId; just create a fresh row
    return prisma.whatsAppChannel.create({
      data: {
        organizationId: orgId,
        isPrimary: true,
        webhookVerifyToken: 'test',
        accessToken: 'test_token',
        phoneNumberId: '12345',
        isActive: true,
      },
    });
  });
  return c.id;
}

describe('broadcasts', () => {
  it('create → manual audience → cancel transitions states correctly', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'bcast-a');
    const channelId = await ensureChannel(a.orgId);
    const templateId = await createApprovedTemplate(a.orgId);

    // 1. Create broadcast
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/broadcasts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: {
        name: 'Test campaign',
        channelId,
        audienceKind: 'manual',
        manualPhones: ['+14155550199', '+14155550200'],
        abTest: false,
        variantATemplateId: templateId,
        variantAVariables: { '1': { kind: 'static', value: 'Friend' } },
      },
    });
    expect(create.statusCode).toBe(201);
    const broadcastId = (create.json() as { data: { id: string } }).data.id;

    // 2. Confirm draft + 2 recipients materialized
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/broadcasts/${broadcastId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const dto = (get.json() as { data: { status: string; totalRecipients: number } }).data;
    expect(dto.status).toBe('draft');
    expect(dto.totalRecipients).toBe(2);

    // 3. Cancel
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/broadcasts/${broadcastId}/cancel`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(cancel.statusCode).toBe(200);
    const cancelDto = (cancel.json() as { data: { status: string } }).data;
    expect(cancelDto.status).toBe('cancelled');
  });

  it('rejects sending a template that is not approved', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'bcast-pending');
    const channelId = await ensureChannel(a.orgId);
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const tpl = await prisma.whatsAppTemplate.create({
      data: {
        organizationId: a.orgId,
        name: `tpl_pending_${Date.now()}`,
        language: 'en_US',
        category: 'MARKETING',
        bodyText: 'Hello',
        status: 'pending',
      },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/broadcasts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: {
        name: 'Bad template',
        channelId,
        audienceKind: 'manual',
        manualPhones: ['+14155550555'],
        abTest: false,
        variantATemplateId: tpl.id,
      },
    });
    expect(create.statusCode).toBe(400);
  });
});
