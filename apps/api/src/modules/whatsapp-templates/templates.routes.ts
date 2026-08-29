// Phase 3 §5.1.2 — WhatsApp message templates.
//
// Meta requires pre-approved templates for any message sent OUTSIDE the
// 24-hour customer session window (marketing, utility, authentication
// flows). This module lets clients author templates locally, submit them
// to Meta for approval, and track approval status.
//
// Submission to Meta uses the WABA-level endpoint
// POST /v25.0/{waba_id}/message_templates. Status updates are pushed via
// the same webhook URL Meta uses for messages — when we see a
// `message_template_status_update` field in the inbound payload, we
// reconcile our row.
//
// For Session 4 we ship: CRUD, manual submit, manual status refresh.
// Webhook-driven status reconciliation is wired but optional (Meta only
// emits it if the WABA is subscribed to `message_template_status_update`).
import { ApiErrorCode, listEnvelopeSchema, successSchema, uuidSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { env } from '../../lib/env.js';
import { safeFetch } from '../../lib/safe-fetch.js';
import { presignGetUrl } from '../../lib/storage.js';

// Header media (IMAGE/VIDEO/DOCUMENT) handles are stored as the presigned
// Wasabi URL used at submit time — those signatures expire (~1h), so the
// template preview couldn't load the image later (it just showed a placeholder
// icon). Re-sign any of-our-bucket header_handle so the preview shows the real
// image. Non-ours / already-live URLs pass through untouched. Best-effort:
// never throws.
async function freshenHeaderMedia(
  components: Record<string, unknown>[] | null,
): Promise<Record<string, unknown>[] | null> {
  if (!components) return components;
  for (const c of components) {
    if (typeof c.type !== 'string' || c.type.toUpperCase() !== 'HEADER') continue;
    const fmt = typeof c.format === 'string' ? c.format.toUpperCase() : '';
    if (fmt !== 'IMAGE' && fmt !== 'VIDEO' && fmt !== 'DOCUMENT') continue;
    const ex = c.example as { header_handle?: unknown } | undefined;
    const handle = Array.isArray(ex?.header_handle) ? ex!.header_handle[0] : undefined;
    if (typeof handle !== 'string' || !/wasabisys\.com/i.test(handle)) continue;
    try {
      const u = new URL(handle);
      let key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      // path-style URLs prefix the bucket name; virtual-hosted URLs don't.
      if (env.WASABI_BUCKET && key.startsWith(`${env.WASABI_BUCKET}/`)) {
        key = key.slice(env.WASABI_BUCKET.length + 1);
      }
      const fresh = await presignGetUrl(key, 3600);
      c.example = { ...(ex ?? {}), header_handle: [fresh] };
    } catch {
      // leave the original handle untouched on any parse/sign error
    }
  }
  return components;
}

// Meta requires media-header (IMAGE/VIDEO/DOCUMENT) template samples to be a
// HANDLE from its resumable-upload API — NOT a plain URL. We upload the sample
// to `/{app_id}/uploads`, push the bytes, and use the returned handle. Without
// this, Meta rejects the template with "Missing sample parameter for title type".
async function uploadSampleToMeta(args: {
  appId: string;
  accessToken: string;
  sampleUrl: string;
}): Promise<string> {
  // Fetch the sample bytes. If it's one of OUR stored objects, re-presign fresh
  // from its storage key (the stored URL may be expired). Otherwise it's a
  // pasted external URL — fetch it directly through the SSRF-safe fetcher.
  let bytes: Buffer;
  let mime = 'image/jpeg';
  try {
    const ourHost = env.WASABI_PUBLIC_URL_BASE ? new URL(env.WASABI_PUBLIC_URL_BASE).host : null;
    let u: URL | null = null;
    try {
      u = new URL(args.sampleUrl);
    } catch {
      u = null;
    }
    const isOurs = !!(u && ourHost && u.host === ourHost);
    if (isOurs && u) {
      const storageKey = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      const fresh = await presignGetUrl(storageKey);
      const imgRes = await fetch(fresh, { signal: AbortSignal.timeout(20_000) });
      if (!imgRes.ok) throw new Error(`sample fetch HTTP ${imgRes.status}`);
      mime = (imgRes.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'image/jpeg';
      bytes = Buffer.from(await imgRes.arrayBuffer());
    } else {
      // External, user-pasted URL — SSRF-guarded fetch.
      const imgRes = await safeFetch(args.sampleUrl, { signal: AbortSignal.timeout(20_000) });
      if (!imgRes.ok) throw new Error(`sample fetch HTTP ${imgRes.status}`);
      mime = (imgRes.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'image/jpeg';
      bytes = Buffer.from(await imgRes.arrayBuffer());
    }
  } catch (err) {
    throw badRequest(
      ApiErrorCode.VALIDATION_ERROR,
      `Could not read the header sample image (${err instanceof Error ? err.message : 'unknown'}).`,
    );
  }

  // 1. Open a resumable-upload session.
  const startRes = await fetch(
    `https://graph.facebook.com/v25.0/${encodeURIComponent(args.appId)}/uploads` +
      `?file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}` +
      `&access_token=${encodeURIComponent(args.accessToken)}`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  const startJson = (await startRes.json().catch(() => null)) as { id?: string; error?: unknown } | null;
  if (!startRes.ok || !startJson?.id) {
    throw badRequest(
      ApiErrorCode.VALIDATION_ERROR,
      `Meta upload session failed: ${JSON.stringify(startJson?.error ?? startJson)}`,
    );
  }

  // 2. Upload the bytes; Meta returns the handle `h`.
  const upRes = await fetch(`https://graph.facebook.com/v25.0/${startJson.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${args.accessToken}`, file_offset: '0' },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  const upJson = (await upRes.json().catch(() => null)) as { h?: string; error?: unknown } | null;
  if (!upRes.ok || !upJson?.h) {
    throw badRequest(
      ApiErrorCode.VALIDATION_ERROR,
      `Meta sample upload failed: ${JSON.stringify(upJson?.error ?? upJson)}`,
    );
  }
  return upJson.h;
}

// Replace media-header URL samples with Meta handles in-place (clones the
// components so the stored row keeps the URL for re-display).
async function resolveMediaHeaderSamples(
  components: Record<string, unknown>[],
  appId: string | null,
  accessToken: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const raw of components) {
    const c = { ...(raw as Record<string, unknown>) };
    const type = String(c.type ?? '').toUpperCase();
    const format = String(c.format ?? '').toUpperCase();
    if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
      const example = (c.example ?? {}) as { header_handle?: unknown };
      const handle = Array.isArray(example.header_handle) ? example.header_handle[0] : undefined;
      // Only upload when it's still a URL (not an already-resolved Meta handle).
      if (typeof handle === 'string' && /^https?:\/\//.test(handle)) {
        if (!appId) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Set the Meta App ID on the WhatsApp page to submit templates with an image/video/document header.',
          );
        }
        const metaHandle = await uploadSampleToMeta({ appId, accessToken, sampleUrl: handle });
        c.example = { header_handle: [metaHandle] };
      }
    }
    out.push(c);
  }
  return out;
}

const templateDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  language: z.string(),
  category: z.string(),
  bodyText: z.string(),
  // Full Meta-shaped components array when present (header / body /
  // footer / buttons). Synced from Meta + populated by the builder UI.
  components: z.array(z.record(z.string(), z.unknown())).nullable(),
  status: z.string(),
  rejectionReason: z.string().nullable(),
  metaTemplateId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export default async function whatsappTemplatesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /whatsapp/templates ----------------------------------
  r.get(
    '/whatsapp/templates',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'List message templates (any status).',
        response: { 200: listEnvelopeSchema(templateDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppTemplate.findMany({ orderBy: { updatedAt: 'desc' } });
        return {
          data: await Promise.all(
            rows.map(async (t) => ({
              id: t.id,
              name: t.name,
              language: t.language,
              category: t.category,
              bodyText: t.bodyText,
              components: await freshenHeaderMedia(
                Array.isArray(t.components)
                  ? (t.components as unknown as Record<string, unknown>[])
                  : null,
              ),
              status: t.status,
              rejectionReason: t.rejectionReason,
              metaTemplateId: t.metaTemplateId,
              createdAt: t.createdAt.toISOString(),
              updatedAt: t.updatedAt.toISOString(),
            })),
          ),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /whatsapp/templates ---------------------------------
  // The optional `components` field accepts the full Meta-shaped JSON
  // (header / body / footer / buttons). When provided, it's the source
  // of truth at submit time. When omitted, we fall back to a single
  // BODY component built from bodyText so the simple flow still works.
  const componentsSchema = z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('HEADER'),
        format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
        text: z.string().max(60).optional(),
        example: z
          .object({
            header_text: z.array(z.string()).optional(),
            header_handle: z.array(z.string().url()).optional(),
          })
          .optional(),
      }),
      z.object({
        type: z.literal('BODY'),
        text: z.string().trim().min(1).max(1024),
        example: z
          .object({ body_text: z.array(z.array(z.string())) })
          .optional(),
      }),
      z.object({
        type: z.literal('FOOTER'),
        text: z.string().trim().min(1).max(60),
      }),
      z.object({
        type: z.literal('BUTTONS'),
        buttons: z
          .array(
            z.discriminatedUnion('type', [
              z.object({
                type: z.literal('QUICK_REPLY'),
                text: z.string().trim().min(1).max(25),
              }),
              z.object({
                type: z.literal('URL'),
                text: z.string().trim().min(1).max(25),
                url: z.string().url().max(2000),
                example: z.array(z.string()).optional(),
              }),
              z.object({
                type: z.literal('PHONE_NUMBER'),
                text: z.string().trim().min(1).max(25),
                phone_number: z
                  .string()
                  .trim()
                  .regex(/^\+?[0-9]{6,16}$/, 'E.164 phone number'),
              }),
              z.object({
                type: z.literal('COPY_CODE'),
                example: z.string().trim().min(1).max(15),
              }),
            ]),
          )
          .min(1)
          .max(10),
      }),
    ]),
  );

  r.post(
    '/whatsapp/templates',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Create a draft template (full Meta components supported).',
        body: z.object({
          name: z
            .string()
            .trim()
            .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits, and underscore only.')
            .min(1)
            .max(64),
          language: z.string().trim().min(2).max(8).default('en_US'),
          category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
          bodyText: z.string().trim().min(1).max(1024),
          components: componentsSchema.optional(),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.whatsAppTemplate.create({
          data: {
            organizationId: req.auth!.organizationId,
            name: req.body.name,
            language: req.body.language,
            category: req.body.category,
            bodyText: req.body.bodyText,
            components: (req.body.components ?? null) as never,
            status: 'draft',
          },
        });
        return { data: { id: created.id } };
      }),
  );

  // ---------- POST /whatsapp/templates/:id/submit ----------------------
  // Pushes the template to Meta for approval. Meta replies with a template
  // id + initial status (usually `PENDING`). We reconcile when the
  // status-update webhook fires (or via /refresh).
  r.post(
    '/whatsapp/templates/:id/submit',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Submit a draft template to Meta for approval.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const tpl = await tx.whatsAppTemplate.findFirst({ where: { id: req.params.id } });
        if (!tpl) throw notFound('Template not found.');
        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!channel?.wabaId || !channel?.accessToken) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure WABA ID + access token on the WhatsApp page first.',
          );
        }

        // Use the full components array when the operator built one;
        // otherwise fall back to a single BODY built from bodyText so
        // the simple "just type the body" flow still works.
        const storedComponents = Array.isArray(tpl.components)
          ? (tpl.components as unknown as Record<string, unknown>[])
          : null;
        // Media-header samples must be Meta upload handles, not URLs — resolve
        // them now (uploads the image to Meta's resumable-upload API).
        const components =
          storedComponents && storedComponents.length > 0
            ? await resolveMediaHeaderSamples(storedComponents, channel.appId, channel.accessToken)
            : [{ type: 'BODY', text: tpl.bodyText }];
        // Edit vs create. A template already on Meta (has a metaTemplateId) is
        // EDITED via POST /{template_id} — name + language are IMMUTABLE there,
        // so we send only category + components, and Meta resets it to PENDING
        // for re-review. A brand-new template is CREATED via the WABA endpoint.
        const isEdit = !!tpl.metaTemplateId;
        const payload = isEdit
          ? { category: tpl.category, components }
          : { name: tpl.name, language: tpl.language, category: tpl.category, components };
        const submitUrl = isEdit
          ? `https://graph.facebook.com/v25.0/${encodeURIComponent(tpl.metaTemplateId!)}`
          : `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.wabaId)}/message_templates`;

        let resBody = '';
        let resStatus = 0;
        try {
          const res = await fetch(submitUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          });
          resStatus = res.status;
          resBody = await res.text();
        } catch (err) {
          await tx.whatsAppTemplate.update({
            where: { id: tpl.id },
            data: { status: 'rejected', rejectionReason: err instanceof Error ? err.message : 'fetch failed' },
          });
          throw badRequest(
            ApiErrorCode.SERVICE_UNAVAILABLE,
            'Meta unreachable; template marked as rejected so it can be edited and resubmitted.',
          );
        }

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(resBody) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (resStatus < 200 || resStatus >= 300 || !parsed) {
          const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
          const s = (k: string) => (typeof errObj[k] === 'string' ? (errObj[k] as string) : null);
          // Meta's top-level `message` is often just "Invalid parameter". The
          // useful "which field / why" text lives in error_user_title,
          // error_user_msg, or error_data — surface the most specific we got so
          // the operator sees WHAT to fix, not a generic "Invalid parameter".
          let errData: string | null = null;
          if (errObj.error_data && typeof errObj.error_data === 'object') {
            const d = errObj.error_data as Record<string, unknown>;
            errData =
              (typeof d.details === 'string' && d.details) ||
              (typeof d.blame_field_specs === 'object' ? JSON.stringify(d.blame_field_specs) : null) ||
              null;
          }
          const code =
            typeof errObj.code === 'number'
              ? ` (Meta code ${errObj.code}${errObj.error_subcode ? `/${String(errObj.error_subcode)}` : ''})`
              : '';
          const detail =
            [s('error_user_title'), s('error_user_msg'), errData].filter(Boolean).join(' — ') ||
            s('message') ||
            `HTTP ${resStatus}`;
          // A code-100 "Invalid parameter" on submit most often means the
          // template already exists in Meta (same name+language) — in that case
          // it may already be APPROVED there. Steer the operator to Sync rather
          // than implying they must rewrite it.
          const looksLikeDuplicate =
            /already exist|same name|duplicate|name.*taken/i.test(`${detail} ${s('message') ?? ''}`) ||
            String(errObj.error_subcode) === '2388023';
          await tx.whatsAppTemplate.update({
            where: { id: tpl.id },
            data: {
              status: 'rejected',
              rejectionReason: looksLikeDuplicate
                ? `This template already exists in Meta — click "Sync from Meta" to pull its real status.${code}`
                : `${detail}${code}`,
            },
          });
          return { data: { ok: false, status: 'rejected' } };
        }

        await tx.whatsAppTemplate.update({
          where: { id: tpl.id },
          data: {
            // Create returns the new template's status + id. Edit returns
            // { success: true } (no id/status) and Meta moves it to PENDING for
            // re-review — so default to 'pending' and KEEP the existing meta id.
            status: typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'pending',
            metaTemplateId: typeof parsed.id === 'string' ? parsed.id : tpl.metaTemplateId,
            rejectionReason: null,
          },
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_template',
          entityId: tpl.id,
          metadata: { event: 'template_submitted', name: tpl.name },
        });

        return { data: { ok: true, status: 'pending' } };
      });
    },
  );

  // ---------- PUT /whatsapp/templates/:id -------------------------------
  // Edit a template's content. Once a template exists on Meta (metaTemplateId
  // set) its name + language are IMMUTABLE — Meta only lets you change category
  // + components, and doing so sends it back for re-review. So we lock those
  // two fields for on-Meta templates and reset the row to 'draft' locally; the
  // operator then clicks Submit, which (being edit-aware) resubmits to Meta.
  r.put(
    '/whatsapp/templates/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Edit a template. Name/language are locked once it exists on Meta.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          name: z
            .string()
            .trim()
            .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only.')
            .max(512)
            .optional(),
          language: z.string().trim().min(2).max(8).optional(),
          category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
          bodyText: z.string().optional(),
          components: componentsSchema.optional(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const tpl = await tx.whatsAppTemplate.findFirst({ where: { id: req.params.id } });
        if (!tpl) throw notFound('Template not found.');
        const onMeta = !!tpl.metaTemplateId;
        if (
          onMeta &&
          ((req.body.name && req.body.name !== tpl.name) ||
            (req.body.language && req.body.language !== tpl.language))
        ) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Name and language cannot change once a template exists on Meta. Create a new template instead.',
          );
        }
        const updated = await tx.whatsAppTemplate.update({
          where: { id: tpl.id },
          data: {
            name: !onMeta && req.body.name ? req.body.name : tpl.name,
            language: !onMeta && req.body.language ? req.body.language : tpl.language,
            category: req.body.category ?? tpl.category,
            bodyText: req.body.bodyText ?? tpl.bodyText,
            components: (req.body.components ?? tpl.components) as never,
            // Editing invalidates any prior verdict — back to draft until the
            // operator explicitly resubmits for review.
            status: 'draft',
            rejectionReason: null,
          },
        });
        return { data: { id: updated.id, status: updated.status } };
      });
    },
  );

  // ---------- POST /whatsapp/templates/sync -----------------------------
  // Pulls every template from Meta (the WABA-level message_templates
  // endpoint) and upserts them into our DB. Covers two gaps:
  //   1. Templates the operator created directly in Meta's WhatsApp
  //      Manager UI never landed here — sync imports them.
  //   2. Templates submitted through our portal still showed as
  //      `pending` after Meta approved them, because we don't yet
  //      process the `message_template_status_update` webhook field.
  //      Sync re-reads the authoritative status from Meta.
  // Auth: admin-only; uses the org's stored WABA id + access token.
  r.post(
    '/whatsapp/templates/sync',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Sync templates from Meta (import new + refresh status).',
        response: {
          200: z.object({
            data: z.object({
              imported: z.number().int(),
              updated: z.number().int(),
              total: z.number().int(),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!channel?.wabaId || !channel?.accessToken) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure WABA ID + access token on the WhatsApp page first.',
          );
        }

        // Page through Meta's templates list. Defaults to 100 per page
        // and follows paging.next links until exhausted or we hit 500
        // templates (generous upper bound — most accounts have <50).
        type MetaTemplate = {
          id?: string;
          name?: string;
          language?: string;
          category?: string;
          status?: string;
          rejected_reason?: string;
          components?: { type?: string; text?: string }[];
        };

        const remote: MetaTemplate[] = [];
        let next: string | null =
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.wabaId)}/message_templates` +
          `?fields=id,name,language,category,status,rejected_reason,components&limit=100`;
        let hops = 0;
        while (next && hops < 10 && remote.length < 500) {
          hops += 1;
          let payload: { data?: MetaTemplate[]; paging?: { next?: string } } = {};
          try {
            const res = await fetch(next, {
              headers: { Authorization: `Bearer ${channel.accessToken}` },
              signal: AbortSignal.timeout(10_000),
            });
            const text = await res.text();
            if (!res.ok) {
              throw badRequest(
                ApiErrorCode.SERVICE_UNAVAILABLE,
                `Meta returned HTTP ${res.status} from message_templates: ${text.slice(0, 200)}`,
              );
            }
            payload = JSON.parse(text) as typeof payload;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              throw badRequest(
                ApiErrorCode.SERVICE_UNAVAILABLE,
                'Meta /message_templates timed out (10s).',
              );
            }
            throw err;
          }
          for (const t of payload.data ?? []) remote.push(t);
          next = payload.paging?.next ?? null;
        }

        // Upsert by (organizationId, metaTemplateId) when we have a
        // Meta id; fall back to (organizationId, name, language) so
        // templates submitted through our portal get reconciled too.
        let imported = 0;
        let updated = 0;
        for (const t of remote) {
          if (!t.name || !t.language) continue;
          const bodyText =
            (t.components ?? []).find((c) => (c.type ?? '').toUpperCase() === 'BODY')?.text ?? '';
          const status = (t.status ?? 'pending').toLowerCase();
          const category = (t.category ?? 'UTILITY').toUpperCase();

          // Match by Meta id first, then ALWAYS fall back to (name, language).
          // Critical: a locally-submitted row often has metaTemplateId=null
          // (e.g. the submit returned an error before Meta issued an id, yet the
          // template still exists + got approved on Meta's side). Matching ONLY
          // by metaTemplateId missed it → the code tried to CREATE a duplicate →
          // the (org, name, language) unique index threw → the WHOLE sync 500'd
          // and the stale 'rejected' status could never be reconciled. The
          // name+language fallback UPDATES that row to Meta's real status.
          const existing =
            (t.id
              ? await tx.whatsAppTemplate.findFirst({
                  where: { organizationId: orgId, metaTemplateId: t.id },
                })
              : null) ??
            (await tx.whatsAppTemplate.findFirst({
              where: { organizationId: orgId, name: t.name, language: t.language },
            }));

          // Store the full components array Meta sent us. Makes the
          // builder UI editable (operator can read/edit existing
          // headers/footers/buttons) and lets future submits include
          // every component without us having to remodel each one.
          const components = Array.isArray(t.components) ? (t.components as unknown) : null;
          // Meta returns "NONE" for approved templates with no rejection reason
          // — treat that as null so the UI never has to guess.
          const rejectionReason =
            t.rejected_reason && t.rejected_reason.toUpperCase() !== 'NONE' ? t.rejected_reason : null;
          // Per-row guard: never let a single bad template (e.g. an unexpected
          // duplicate) throw and 500 the whole sync — log + skip it instead.
          try {
            if (existing) {
              await tx.whatsAppTemplate.update({
                where: { id: existing.id },
                data: {
                  metaTemplateId: t.id ?? existing.metaTemplateId,
                  status,
                  category,
                  bodyText: bodyText || existing.bodyText,
                  components: components as never,
                  rejectionReason,
                },
              });
              updated += 1;
            } else {
              await tx.whatsAppTemplate.create({
                data: {
                  organizationId: orgId,
                  name: t.name,
                  language: t.language,
                  category,
                  bodyText: bodyText || '(imported from Meta — no body component)',
                  components: components as never,
                  status,
                  metaTemplateId: t.id ?? null,
                  rejectionReason,
                },
              });
              imported += 1;
            }
          } catch (err) {
            req.log.warn(
              { err, name: t.name, language: t.language, metaId: t.id },
              '[templates] sync: skipped one template row that failed to upsert',
            );
          }
        }

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_template',
          // The sync touches the whole template set, not a single row.
          // recordAudit's entityId is string | undefined; pass undefined
          // (no entity) rather than null (typing mismatch).
          entityId: undefined,
          metadata: { event: 'templates_synced', imported, updated, total: remote.length },
        });

        return { data: { imported, updated, total: remote.length } };
      });
    },
  );

  // ---------- DELETE /whatsapp/templates/:id ---------------------------
  r.delete(
    '/whatsapp/templates/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Delete a template (local only — Meta-side approved templates need separate removal in Meta).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.whatsAppTemplate.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );
}
