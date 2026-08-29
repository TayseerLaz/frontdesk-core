import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { withTenant } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Helper: run a tenant-scoped DB callback. Use this from any authenticated
     * route to ensure RLS sees the correct organization_id.
     *
     *   const products = await app.tenant(req, (tx) => tx.product.findMany());
     */
    tenant: <T>(
      req: FastifyRequest,
      fn: (tx: Parameters<typeof withTenant>[1] extends (tx: infer X) => unknown ? X : never) => Promise<T>,
    ) => Promise<T>;
  }
}

export default fp(async function tenantContext(app: FastifyInstance) {
  app.decorate('tenant', async (req, fn) => {
    await app.requireAuth(req);
    return withTenant(req.auth!.organizationId, fn);
  });
});
