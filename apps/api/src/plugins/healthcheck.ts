import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { prisma } from '../lib/db.js';
import { getRedis } from '../lib/redis.js';

export default fp(async function healthcheck(app: FastifyInstance) {
  app.get('/health', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { logLevel: 'silent' }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }
    try {
      const redis = getRedis();
      const pong = await redis.ping();
      checks.redis = pong === 'PONG' ? 'ok' : 'fail';
    } catch {
      checks.redis = 'fail';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });
});
