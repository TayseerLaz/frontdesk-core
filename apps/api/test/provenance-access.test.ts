// Sprint 1 M-6 — regression test for Phase 8 provenance access gating.
//
// The message provenance store contains the *exact* system prompt sent to the
// LLM, full conversation history, candidate KB rows, and hallucination scan
// results for every bot reply. It must NEVER be readable by:
//   • a regular org admin (only super-admins),
//   • an unauthenticated client.
//
// Both surfaces are checked:
//   • POST/GET /api/v1/hq/provenance       — cross-tenant browser
//   • GET     /api/v1/inbox/messages/:id/provenance  — per-message detail
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp } from './setup.js';

describe('provenance access gating', () => {
  it('hq/provenance is 401 without auth', async () => {
    const app = getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/hq/provenance',
    });
    expect(res.statusCode).toBe(401);
  });

  it('hq/provenance is 403 for a regular org admin', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'provacc1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/hq/provenance',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('inbox/messages/:id/provenance is 401 without auth', async () => {
    const app = getApp();
    const fakeMessageId = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/inbox/messages/${fakeMessageId}/provenance`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('inbox/messages/:id/provenance is 403 for a regular org admin', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'provacc2');
    const fakeMessageId = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/inbox/messages/${fakeMessageId}/provenance`,
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
