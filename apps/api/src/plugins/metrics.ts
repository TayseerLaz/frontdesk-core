import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

export default fp(async function metricsPlugin(app: FastifyInstance) {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'aligned-api' });
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [registry],
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = (req.routeOptions?.url ?? req.url).split('?')[0] ?? 'unknown';
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDurationSeconds.observe(labels, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { logLevel: 'silent' }, async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});
