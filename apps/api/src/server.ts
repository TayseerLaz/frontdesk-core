import { BRAND } from '@platform/shared';
import './lib/bigint-json.js'; // BigInt JSON shim — must load before anything serializes a bigint
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import underPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { env } from './lib/env.js';
import { getRedis } from './lib/redis.js';
import { initSentry } from './lib/sentry.js';
import { resolveTrustProxy, trustCfConnectingIp } from './lib/trust-proxy.js';
import accountRoutes from './modules/account/account.routes.js';
import twoFactorRoutes from './modules/account/2fa.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import botRoutes from './modules/bot/bot.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import dataExportRoutes from './modules/data-export/data-export.routes.js';
import orgRoutes from './modules/org/org.routes.js';
import saasRoutes from './modules/saas/saas.routes.js';
import statusRoutes from './modules/status/status.routes.js';
import inboxRoutes from './modules/whatsapp-inbox/inbox.routes.js';
import whatsappRoutes from './modules/whatsapp/whatsapp.routes.js';
import whatsappTemplatesRoutes from './modules/whatsapp-templates/templates.routes.js';
import apiKeyRoutes from './modules/api-keys/api-keys.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import bookingsRoutes from './modules/bookings/bookings.routes.js';
import cartsRoutes from './modules/carts/carts.routes.js';
import paymentRoutes from './modules/payments/payment.routes.js';
import paymentWebhookRoutes from './modules/payments/payment-webhook.routes.js';
import messengerRoutes from './modules/messenger/messenger.routes.js';
import businessInfoRoutes from './modules/catalog/business-info.routes.js';
import categoryRoutes from './modules/catalog/category.routes.js';
import productRoutes from './modules/catalog/product.routes.js';
import serviceRoutes from './modules/catalog/service.routes.js';
import connectorRoutes from './modules/connectors/connector.routes.js';
import inboundWebhookRoutes from './modules/connectors/inbound-webhook.routes.js';
import googleCalendarRoutes from './modules/google-calendar/google-calendar.routes.js';
import salesScanExportRoutes from './modules/sales-scan/sales-scan-export.routes.js';
import salesScanIngestRoutes from './modules/sales-scan/sales-scan-ingest.routes.js';
import salesScanRoutes from './modules/sales-scan/sales-scan.routes.js';
import shopifyRoutes from './modules/shopify/shopify.routes.js';
import shopifyWebhookRoutes from './modules/shopify/shopify-webhook.routes.js';
import contactSyncRoutes from './modules/contacts/contact-sync.routes.js';
import waContactsRoutes from './modules/contacts/wa-contacts.routes.js';
import contactsRoutes from './modules/contacts/contacts.routes.js';
import broadcastsRoutes from './modules/broadcasts/broadcasts.routes.js';
import segmentsRoutes from './modules/segments/segments.routes.js';
import sequencesRoutes from './modules/sequences/sequences.routes.js';
import importRoutes from './modules/imports/import.routes.js';
import memberRoutes from './modules/members/members.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import readApiRoutes from './modules/read/read.routes.js';
import voiceRoutes from './modules/voice/voice.routes.js';
import phoneIntegrationRoutes from './modules/voice/phone-integration.routes.js';
import revisionRoutes from './modules/revisions/revisions.routes.js';
import multipartUploadRoutes from './modules/storage/multipart-upload.routes.js';
import storageRoutes from './modules/storage/storage.routes.js';
import webhookEndpointRoutes from './modules/webhooks/webhooks.routes.js';
import apiKeyPlugin from './plugins/api-key.js';
import voiceGatewayPlugin from './plugins/voice-gateway.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';
import healthcheck from './plugins/healthcheck.js';
import metrics from './plugins/metrics.js';
import tenantContext from './plugins/tenant-context.js';

// Phase 11.5 — bump the undici HTTP-agent keep-alive window from the
// default 4s to 60s, and bump max connections per host. Cuts ~50-150 ms
// off every outbound call to api.openai.com / api.elevenlabs.io /
// graph.facebook.com when traffic is steady (we make 3-5 of these per
// bot reply, so the savings stack). Affects every `fetch()` call in
// the api process + every SDK that wraps the global fetch (incl. the
// OpenAI SDK on Node 20+).
async function tuneHttpAgent(): Promise<void> {
  try {
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 60_000, // hold the TCP socket open for 60s
        keepAliveMaxTimeout: 600_000, // cap to 10 min total reuse
        connections: 64, // up from default 1 per origin
      }),
    );
  } catch {
    // undici isn't strictly required; node's built-in fetch still works.
  }
}

export async function buildServer() {
  initSentry();
  await tuneHttpAgent();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["x-hub-signature-256"]',
          'req.headers["x-signature"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.token',
          'req.body.accessToken',
          'req.body.appSecret',
          'req.body.pageAccessToken',
          'req.body.authConfig',
          'req.body.credentials',
          '*.passwordHash',
          '*.refreshTokenHash',
          '*.tokenHash',
          '*.keyHash',
          '*.signingSecret',
          '*.webhookSecret',
          // Tenant integration secrets — Meta/WhatsApp/Messenger tokens, connector
          // auth blobs. Without these a single logged Prisma row or request body
          // leaks the ability to act as the tenant on their channels (F-08).
          '*.accessToken',
          '*.appSecret',
          '*.pageAccessToken',
          '*.authConfig',
          '*.credentials',
          '*.verifyToken',
        ],
        remove: true,
      },
    },
    // Sprint 4 — WAF readiness. Default 'true' preserves backward-compat with
    // the Caddy-only deployment; set TRUST_PROXY=cloudflare (or a CIDR list)
    // to lock down which upstreams can set X-Forwarded-For without being
    // overridden by a malicious public client.
    trustProxy: resolveTrustProxy(),
    disableRequestLogging: false,
    bodyLimit: 5 * 1024 * 1024, // 5 MB. CSV/Excel imports use the multipart route (10 MB capped there).
    genReqId: () => crypto.randomUUID(),
  });

  // Sprint 4 — when TRUST_CF_CONNECTING_IP=true, prefer the single-value
  // CF-Connecting-IP header (set ONLY by Cloudflare) over the X-Forwarded-For
  // chain. Cloudflare strips inbound copies of this header at its edge, so it
  // is forge-resistant once we trust their IP ranges. We mutate the
  // (privately-typed) `ip` getter via Object.defineProperty so downstream
  // rate-limit + audit-log consumers see the real client.
  if (trustCfConnectingIp()) {
    app.addHook('onRequest', (req, _reply, done) => {
      const cf = req.headers['cf-connecting-ip'];
      const ip = Array.isArray(cf) ? cf[0] : cf;
      if (ip && typeof ip === 'string' && ip.length > 0) {
        Object.defineProperty(req, 'ip', { value: ip, configurable: true });
      }
      done();
    });
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Capture the raw JSON body on every request before parsing so HMAC
  // verifiers (WhatsApp Cloud API, Stripe webhooks, etc.) can compute
  // signatures against Meta's/Stripe's original bytes — not a Node
  // re-stringification that may reorder keys or change escaping and
  // break the HMAC comparison. The body is attached at `req.rawBody`.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        const buf = body as Buffer;
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
        const parsed = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );

  // Security & basics.
  //
  // CSP is enabled for the API surface to keep first-party UIs (Swagger UI at
  // /docs and /docs/chatbot) safe from script injection. Inline styles are
  // allowed because swagger-ui-dist relies on them. JSON API responses are
  // not script contexts, so CSP only matters for those embedded UIs and
  // anything that ever renders user input as HTML.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https://*.wasabisys.com'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': [],
      },
    },
    crossOriginEmbedderPolicy: false, // Swagger UI assets break under require-corp
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xssFilter: false, // deprecated; CSP supersedes
  });

  // Permissions-Policy — @fastify/helmet no longer manages this header. The API
  // exposes no browser-feature surface, so switch them all off (parity with the
  // portal, which sets its own Permissions-Policy).
  app.addHook('onRequest', (_req, reply, done) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    done();
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });

  // Only advertise credentialed CORS to origins we actually allow. @fastify/cors
  // emits Access-Control-Allow-Credentials on every response when credentials:true
  // — even when the Origin was not allow-listed and no Access-Control-Allow-Origin
  // is set. A lone ACAC header is harmless to browsers (they require a matching
  // ACAO) but confuses audits; strip it whenever we did not echo an allowed origin.
  app.addHook('onSend', (_req, reply, payload, done) => {
    if (!reply.getHeader('access-control-allow-origin')) {
      reply.removeHeader('access-control-allow-credentials');
    }
    done(null, payload);
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  await app.register(rateLimit, {
    global: true,
    timeWindow: '1 second',
    redis: getRedis(),
    nameSpace: 'platform-rl:',
    skipOnError: true,
    // Chatbot Read API + voice media gateway get their own (higher) ceiling
    // per API key. Voice especially: the bridge ships every transcript turn
    // from one VPS IP — under the per-IP bucket a busy hour of calls would
    // 429 and silently drop transcripts.
    // The Meta webhook joins them. Coexistence `history` arrives in 3 phases,
    // multiple chunks per phase, from Meta's IPs — on top of live traffic for
    // every number on the app. Under the 100/s per-IP bucket a burst 429s, and
    // `history` is delivered ONCE with no re-request, so a 429 is permanent loss.
    max: (req) =>
      req.url.startsWith('/api/v1/read/') ||
      req.url.startsWith('/api/v1/voice/') ||
      req.url.startsWith('/api/v1/whatsapp/webhook/')
        ? env.RATE_LIMIT_READ_API_PER_SECOND
        : env.RATE_LIMIT_API_PER_SECOND,
    // Bypass for Playwright runs. Only outside production; the header is set
    // by apps/e2e/playwright.config.ts.
    allowList: (req) =>
      env.NODE_ENV !== 'production' && req.headers['x-e2e-run'] === '1',
    keyGenerator: (req) => {
      if (req.url.startsWith('/api/v1/read/') || req.url.startsWith('/api/v1/voice/')) {
        const apiKey = req.headers['x-api-key'];
        return Array.isArray(apiKey) ? apiKey[0] ?? req.ip : (apiKey ?? req.ip);
      }
      return req.ip;
    },
  });

  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1024 * 1024 * 1024, // 1 GB
    maxRssBytes: 1024 * 1024 * 1024 * 2, // 2 GB
    maxEventLoopUtilization: 0.98,
    healthCheckInterval: 5000,
    exposeStatusRoute: false,
  });

  // OpenAPI / Swagger UI
  await app.register(swagger, {
    openapi: {
      info: {
        title: `${BRAND.name} API`,
        version: '0.1.0',
        description: 'Multi-tenant catalog + chatbot read API.',
      },
      servers: [{ url: env.API_PUBLIC_URL }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
      tags: [
        { name: 'auth', description: 'Authentication, sessions, invitations' },
        { name: 'members', description: 'Members + roles' },
        { name: 'catalog', description: 'Products, services, categories' },
        { name: 'business-info', description: 'Hours, locations, contacts, FAQs, policies' },
        { name: 'storage', description: 'Asset uploads' },
        { name: 'imports', description: 'CSV/Excel imports' },
        { name: 'connectors', description: 'API connectors + scheduled syncs' },
        { name: 'webhooks', description: 'Outbound webhooks' },
        { name: 'api-keys', description: 'API keys for the chatbot read API' },
        { name: 'chatbot-read', description: 'Read-only API consumed by the WhatsApp chatbot' },
        { name: 'voice', description: 'Voice media gateway — call config, lifecycle, transcripts' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  // SECURITY: the full Swagger UI + /docs/json map every backend route
  // (including admin / impersonation / revenue). Never serve it publicly in
  // production — gate behind an explicit opt-in env so it stays available in
  // dev/staging. (The OpenAPI `swagger` plugin above only generates the spec
  // in-memory; without the UI registration there is no /docs or /docs/json.)
  const docsPublic = env.NODE_ENV !== 'production' || process.env.API_DOCS_PUBLIC === 'true';
  if (docsPublic) {
    await app.register(swaggerUi, { routePrefix: '/docs' });

  // Filtered chatbot-only Swagger UI on /docs/chatbot using its own swagger plugin.
  await app.register(async (chatbotScope) => {
    await chatbotScope.register(swagger, {
      openapi: {
        info: {
          title: `${BRAND.name} Chatbot Read API`,
          version: '0.1.0',
          description: 'Read-only endpoints for chatbot integrations. API-key authenticated.',
        },
        servers: [{ url: env.API_PUBLIC_URL }],
        components: {
          securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
        },
      },
      transform: jsonSchemaTransform,
      // Only expose chatbot-read tagged routes.
      // Note: routes are registered globally above; this swagger instance
      // observes them via the parent encapsulation context.
    });
    await chatbotScope.register(swaggerUi, { routePrefix: '/docs/chatbot' });
  });
  }

  // App-specific
  await app.register(errorHandler);
  await app.register(metrics);
  await app.register(healthcheck);
  await app.register(authPlugin);
  await app.register(apiKeyPlugin);
  await app.register(voiceGatewayPlugin);
  await app.register(tenantContext);

  // Routes — portal (JWT cookie/bearer)
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(memberRoutes, { prefix: '/api/v1' });
  await app.register(storageRoutes, { prefix: '/api/v1' });
  await app.register(multipartUploadRoutes, { prefix: '/api/v1' });
  await app.register(categoryRoutes, { prefix: '/api/v1' });
  await app.register(productRoutes, { prefix: '/api/v1' });
  await app.register(serviceRoutes, { prefix: '/api/v1' });
  await app.register(businessInfoRoutes, { prefix: '/api/v1' });
  await app.register(paymentRoutes, { prefix: '/api/v1' });
  await app.register(messengerRoutes, { prefix: '/api/v1' });
  await app.register(bookingsRoutes, { prefix: '/api/v1' });
  await app.register(googleCalendarRoutes, { prefix: '/api/v1' });
  await app.register(salesScanRoutes, { prefix: '/api/v1' });
  // Separate module: the CSV export is admin-only (it carries third-party phone
  // numbers) while the rest of the Sales Scan reads are viewer-level.
  await app.register(salesScanExportRoutes, { prefix: '/api/v1' });
  await app.register(cartsRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1' });
  await app.register(connectorRoutes, { prefix: '/api/v1' });
  await app.register(shopifyRoutes, { prefix: '/api/v1' });
  await app.register(webhookEndpointRoutes, { prefix: '/api/v1' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1' });
  await app.register(phoneIntegrationRoutes, { prefix: '/api/v1' });
  await app.register(revisionRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  await app.register(auditRoutes, { prefix: '/api/v1' });
  await app.register(accountRoutes, { prefix: '/api/v1' });
  await app.register(twoFactorRoutes, { prefix: '/api/v1' });
  await app.register(dataExportRoutes, { prefix: '/api/v1' });
  await app.register(orgRoutes, { prefix: '/api/v1' });
  await app.register(whatsappRoutes, { prefix: '/api/v1' });
  await app.register(inboxRoutes, { prefix: '/api/v1' });
  await app.register(whatsappTemplatesRoutes, { prefix: '/api/v1' });
  await app.register(botRoutes, { prefix: '/api/v1' });
  await app.register(billingRoutes, { prefix: '/api/v1' });
  await app.register(saasRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(contactsRoutes, { prefix: '/api/v1' });
  // "Sync contacts with phone" — portal routes + the PUBLIC token-authed phone routes.
  await app.register(contactSyncRoutes, { prefix: '/api/v1' });
  // The WhatsApp option's machine seam (HMAC + nonce, own secret). Inert without
  // WA_CONTACTS_SECRET — deliberately NOT the sales-scan credential.
  await app.register(waContactsRoutes, { prefix: '/api/v1' });
  await app.register(segmentsRoutes, { prefix: '/api/v1' });
  await app.register(broadcastsRoutes, { prefix: '/api/v1' });
  await app.register(sequencesRoutes, { prefix: '/api/v1' });

  // Routes — public (HMAC-verified, no JWT)
  await app.register(inboundWebhookRoutes, { prefix: '/api/v1' });
  await app.register(shopifyWebhookRoutes, { prefix: '/api/v1' });
  // Sales Scan capture service (runs off-box on AlignDesk) -> HMAC + skew + replay nonce.
  await app.register(salesScanIngestRoutes, { prefix: '/api/v1' });

  // Routes — public payment-confirmation webhooks (gateway-signed, no JWT)
  await app.register(paymentWebhookRoutes, { prefix: '/api/v1' });

  // Routes — public marketing lead capture (no auth, per-IP rate limited)

  // Routes — public status page data (no auth). Mounted at /api/v1/status.
  await app.register(statusRoutes, { prefix: '/api/v1' });

  // Routes — chatbot read API (X-Api-Key)
  await app.register(readApiRoutes, { prefix: '/api/v1' });

  // Routes — voice media gateway (X-Api-Key for the voicebot bridge;
  // the two /voice/calls GET routes inside are JWT portal routes)
  await app.register(voiceRoutes, { prefix: '/api/v1' });

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.log.info(
      { url: `${env.API_PUBLIC_URL}/docs`, chatbotDocs: `${env.API_PUBLIC_URL}/docs/chatbot` },
      `${BRAND.name} API listening on :${env.API_PORT}`,
    );
    // Continuous embedding backstop — keeps products/services/FAQs embedded no
    // matter how they were added (import / Shopify / direct DB), so the bot's
    // top-K retrieval always works. Idempotent; steady-state ticks are free.
    // Wrapped so a tick wiring error can never take down API boot.
    try {
      const { startEmbedBackfillTick } = await import('./lib/embed-backfill-tick.js');
      const embedTick = startEmbedBackfillTick();
      app.log.info({ name: embedTick.name }, 'embedding backfill tick started');
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start embedding backfill tick (non-fatal)');
    }
    // Google Calendar one-way booking sync — pushes each connected tenant's
    // bookings to their calendar. Dormant until GOOGLE_CLIENT_ID/SECRET are set.
    try {
      const { startGoogleCalendarSyncTick } = await import('./lib/google-calendar-sync-tick.js');
      const gcalTick = startGoogleCalendarSyncTick();
      app.log.info({ name: gcalTick.name }, 'google calendar sync tick started');
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start google calendar sync tick (non-fatal)');
    }
    // Wallet balance-depletion alert tick — notifies tenant + admins when a
    // metered wallet crosses its configured %-used thresholds. Non-fatal.
    try {
      const { startWalletAlertTick } = await import('./lib/wallet-alert-tick.js');
      const walletTick = startWalletAlertTick();
      app.log.info({ name: walletTick.name }, 'wallet alert tick started');
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start wallet alert tick (non-fatal)');
    }
    // Sales Scan safety net: expires windows from the system-of-record side if the
    // capture service is wedged, and — the important half — retries credential purges
    // for any grant with endedAt set but authPurgedAt still null (blocker B1). Always
    // runs: both sweeps are pure Postgres, and gating compliance work on the ingest
    // transport vars is what let a wedged window sit unterminated for six days.
    try {
      const { startSalesScanReaperTick } = await import('./lib/sales-scan-reaper-tick.js');
      startSalesScanReaperTick(app.log);
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start sales-scan reaper tick (non-fatal)');
    }
    // Contact-sync sessions: expire past-deadline rows and prune terminal ones. The table
    // shipped an index documented as driving this sweep before the sweep existed, so
    // sessions accumulated in 'pending' forever and "expired" was only ever a read-time
    // fiction in the poll route.
    try {
      const { startContactSyncReaper } = await import('./lib/contact-sync-reaper-tick.js');
      startContactSyncReaper(app.log);
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start contact-sync reaper tick (non-fatal)');
    }
    // Sales Scan summary pipeline: when a capture window closes, cluster it locally and
    // produce the SalesScanSummary row the portal renders. The corpus never leaves the
    // box — only scrubbed cluster representatives + the tenant's own outbound samples
    // reach the model. Dormant until WA_INGEST_SECRET is set.
    try {
      const { startSalesInsightTick } = await import('./lib/sales-insight-tick.js');
      startSalesInsightTick(app.log);
    } catch (tickErr) {
      app.log.error({ err: tickErr }, 'failed to start sales-scan insight tick (non-fatal)');
    }
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      app.log.info(`${sig} received, draining…`);
      await app.close();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
}
