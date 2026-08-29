// Phase 3 §5.1.4 — GDPR data portability worker.
//
// Reads everything tenant-scoped for the org (catalog, conversations, bot
// config, audit), JSON.stringifies the bundle, gzips it, uploads to Wasabi
// at `exports/<orgId>/<exportId>.json.gz`, then emails the requester a
// short-lived signed download URL.
//
// The "everything" list is deliberately explicit — adding a new tenant
// table later means consciously choosing whether it's part of an export.
// That's safer than reflective walks that quietly include everything.
import { Worker } from 'bullmq';
import JSZip from 'jszip';

import { sendEmail } from '../lib/email.js';
import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { putObject } from '../lib/storage.js';

import { prisma, withRlsBypass } from './db.js';
import {
  bundleToReportSections,
  htmlToPdf,
  renderCombinedHtml,
  renderSectionHtml,
} from './export-report.js';

interface DataExportPayload {
  organizationId: string;
  requestedByUserId: string;
  requestedByEmail: string;
  exportId: string;
  // Which dataset sections to include (keys from shared EXPORT_SECTIONS). Empty
  // / omitted = everything (the tenant self-service export). The admin UI sends
  // an explicit selection so operators pick exactly what's in the file.
  sections?: string[];
  // 'csv' (ZIP of spreadsheets) | 'pdf' (formal report). Default csv.
  format?: string;
  // 'combined' (one file) | 'separate' (one document per section, zipped).
  // Only affects the PDF format. Default combined.
  layout?: string;
}

// Local mirror of shared `exportWants` (kept inline so the worker has no extra
// import surface). Empty selection = include everything.
function want(sections: string[] | undefined, key: string): boolean {
  return !sections || sections.length === 0 || sections.includes(key);
}

// --- CSV helpers -----------------------------------------------------------
// Export is a ZIP of CSV files (one per data type) so it opens directly in
// Excel / Google Sheets. Nested values (rare) are JSON-encoded within a cell.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return '';
  const keys = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  const header = keys.map(csvCell).join(',');
  const lines = rows.map((r) => keys.map((k) => csvCell(r[k])).join(','));
  return [header, ...lines].join('\r\n');
}

// Flatten the gathered bundle into one CSV per entity, zipped. Nested includes
// (variants, images, pricing tiers, availability, tags) become their own CSVs
// linked by a parent-id column. `add` skips empty datasets, so a section the
// operator didn't select (empty array in the bundle) simply produces no file.
async function buildCsvZip(bundle: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  const add = (name: string, rows: Record<string, unknown>[]) => {
    const csv = toCsv(rows);
    if (csv) zip.file(name, csv);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = bundle as any;

  // Always present — the tenant identity.
  if (b.organization) add('organization.csv', [b.organization]);

  // --- Business info ---
  if (b.businessInfo) add('business_info.csv', [b.businessInfo]);
  add('locations.csv', b.locations ?? []);
  add('contact_channels.csv', b.contactChannels ?? []);

  // --- Products ---
  const products: any[] = b.products ?? [];
  add(
    'products.csv',
    products.map(({ variants: _v, images: _i, ...rest }) => rest),
  );
  add(
    'product_variants.csv',
    products.flatMap((p) => (p.variants ?? []).map((v: any) => ({ productId: p.id, ...v }))),
  );
  add(
    'product_images.csv',
    products.flatMap((p) => (p.images ?? []).map((img: any) => ({ productId: p.id, ...img }))),
  );
  add('categories.csv', b.categories ?? []);

  // --- Services ---
  const services: any[] = b.services ?? [];
  add(
    'services.csv',
    services.map(({ pricingTiers: _t, availability: _a, ...rest }) => rest),
  );
  add(
    'service_pricing_tiers.csv',
    services.flatMap((s) => (s.pricingTiers ?? []).map((t: any) => ({ serviceId: s.id, ...t }))),
  );
  add(
    'service_availability.csv',
    services.flatMap((s) => (s.availability ?? []).map((a: any) => ({ serviceId: s.id, ...a }))),
  );

  // --- FAQs & policies ---
  add('faqs.csv', b.faqs ?? []);
  add('policies.csv', b.policies ?? []);

  // --- Clients / contacts ---
  const clients: any[] = b.clients ?? [];
  add(
    'clients.csv',
    clients.map(({ tags: _tg, ...rest }) => rest),
  );
  add(
    'client_tags.csv',
    clients.flatMap((c) => (c.tags ?? []).map((tag: any) => ({ contactId: c.id, ...tag }))),
  );

  // --- Segments ---
  add('segments.csv', b.segments ?? []);

  // --- Broadcasts ---
  add('broadcasts.csv', b.broadcasts ?? []);
  add('broadcast_recipients.csv', b.broadcastRecipients ?? []);
  add('broadcast_events.csv', b.broadcastEvents ?? []);

  // --- Orders / carts ---
  add('orders.csv', b.carts ?? []);
  add('order_items.csv', b.cartItems ?? []);

  // --- Bookings ---
  add('bookings.csv', b.bookings ?? []);

  // --- Conversations ---
  const threads: any[] = b.threads ?? [];
  add(
    'conversation_threads.csv',
    threads.map(({ tags: _tg, ...rest }) => rest),
  );
  add(
    'conversation_thread_tags.csv',
    threads.flatMap((t) => (t.tags ?? []).map((tag: any) => ({ threadId: t.id, ...tag }))),
  );
  add('conversation_messages.csv', b.messages ?? []);
  add('conversation_notes.csv', b.notes ?? []);

  // --- Team members ---
  add('members.csv', b.members ?? []);

  // --- Activity ---
  add('audit_log.csv', b.audit ?? []);

  // --- AI config ---
  if (b.botConfig) add('bot_config.csv', [b.botConfig]);
  // Drop the embedding vector — a huge numeric array that bloats the CSV and
  // isn't human-useful in a portability export.
  add(
    'bot_knowledge_base.csv',
    (b.kb ?? []).map(({ embedding: _e, ...rest }: any) => rest),
  );

  // --- API keys (metadata only — never the secret) ---
  add('api_keys.csv', b.apiKeys ?? []);

  zip.file(
    'README.txt',
    [
      'ALIGNED / Hader data export',
      `Exported: ${new Date().toISOString()}`,
      '',
      'One CSV per data type. Rows that link to a parent (variants, images,',
      'pricing tiers, availability, tags, recipients) carry a parent-id column.',
      'Any nested value is JSON-encoded inside its cell. Only the dataset',
      'sections requested for this export are present.',
    ].join('\n'),
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gatherBundle(orgId: string, sections?: string[]): Promise<Record<string, any>> {
  return withRlsBypass(async (tx) => {
    const where = { organizationId: orgId };
    const organization = await tx.organization.findUnique({ where: { id: orgId } });

    // --- Business info ---
    const [businessInfo, locations, contactChannels] = want(sections, 'business_info')
      ? await Promise.all([
          tx.businessInfo.findUnique({ where: { organizationId: orgId } }),
          tx.location.findMany({ where }),
          tx.contactChannel.findMany({ where }),
        ])
      : [null, [], []];

    // --- Products (with variants + images) + categories ---
    const [products, categories] = want(sections, 'products')
      ? await Promise.all([
          tx.product.findMany({ where, include: { variants: true, images: true } }),
          tx.category.findMany({ where }),
        ])
      : [[], []];

    // --- Services (with pricing tiers + availability) ---
    const services = want(sections, 'services')
      ? await tx.service.findMany({ where, include: { pricingTiers: true, availability: true } })
      : [];

    // --- FAQs & policies ---
    const [faqs, policies] = want(sections, 'faqs_policies')
      ? await Promise.all([tx.fAQ.findMany({ where }), tx.policy.findMany({ where })])
      : [[], []];

    // --- Clients / contacts (the customers) ---
    const clients = want(sections, 'contacts')
      ? await tx.contact.findMany({ where, include: { tags: true } })
      : [];

    // --- Segments ---
    const segments = want(sections, 'segments') ? await tx.segment.findMany({ where }) : [];

    // --- Broadcasts + per-recipient delivery + events ---
    const [broadcasts, broadcastRecipients, broadcastEvents] = want(sections, 'broadcasts')
      ? await Promise.all([
          tx.broadcast.findMany({ where }),
          tx.broadcastRecipient.findMany({ where }),
          tx.broadcastEvent.findMany({ where }),
        ])
      : [[], [], []];

    // --- Orders / carts + line items ---
    const [carts, cartItems] = want(sections, 'orders')
      ? await Promise.all([tx.cart.findMany({ where }), tx.cartItem.findMany({ where })])
      : [[], []];

    // --- Bookings ---
    const bookings = want(sections, 'bookings') ? await tx.booking.findMany({ where }) : [];

    // --- Conversations (heavy + PII; off unless requested) ---
    const [threads, messages, notes] = want(sections, 'conversations')
      ? await Promise.all([
          tx.whatsAppThread.findMany({ where, include: { tags: true } }),
          tx.whatsAppMessage.findMany({ where, orderBy: { receivedAt: 'asc' } }),
          tx.whatsAppNote.findMany({ where }),
        ])
      : [[], [], []];

    // --- Team members (role + email via the user relation) ---
    const memberRows = want(sections, 'members')
      ? await tx.membership.findMany({
          where,
          include: { user: { select: { email: true, firstName: true, lastName: true, status: true } } },
        })
      : [];
    const members = memberRows.map((m) => ({
      userId: m.userId,
      role: m.role,
      isActive: m.isActive,
      email: m.user?.email ?? null,
      firstName: m.user?.firstName ?? null,
      lastName: m.user?.lastName ?? null,
      userStatus: m.user?.status ?? null,
      createdAt: m.createdAt,
    }));

    // --- Activity (last 5,000 audit entries) ---
    const audit = want(sections, 'activity')
      ? await tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5_000 })
      : [];

    // --- AI config + knowledge base ---
    const [botConfig, kb] = want(sections, 'ai')
      ? await Promise.all([
          tx.botConfig.findUnique({ where: { organizationId: orgId } }),
          tx.knowledgeBaseEntry.findMany({ where }),
        ])
      : [null, []];

    // --- API keys (metadata ONLY — never the hash/secret) ---
    const apiKeys = want(sections, 'api_keys')
      ? await tx.apiKey.findMany({
          where,
          select: {
            id: true,
            name: true,
            prefix: true,
            scopes: true,
            lastUsedAt: true,
            revokedAt: true,
            createdAt: true,
          },
        })
      : [];

    return {
      meta: { exportedAt: new Date().toISOString(), format: 'csv+zip', version: 3, sections: sections ?? [] },
      organization,
      businessInfo,
      locations,
      contactChannels,
      products,
      categories,
      services,
      faqs,
      policies,
      clients,
      segments,
      broadcasts,
      broadcastRecipients,
      broadcastEvents,
      carts,
      cartItems,
      bookings,
      threads,
      messages,
      notes,
      members,
      audit,
      botConfig,
      kb,
      apiKeys,
    };
  });
}

export function startDataExportWorker() {
  return new Worker<DataExportPayload>(
    'data-export',
    async (job) => {
      const { organizationId, exportId, requestedByEmail, sections } = job.data;
      const format = job.data.format === 'pdf' ? 'pdf' : 'csv';
      const layout = job.data.layout === 'separate' ? 'separate' : 'combined';

      // Mark running.
      await withRlsBypass((tx) =>
        tx.dataExport.update({
          where: { id: exportId },
          data: { status: 'running', startedAt: new Date() },
        }),
      );

      try {
        const bundle = await gatherBundle(organizationId, sections);

        // Build the requested artifact.
        let body: Buffer;
        let ext: string;
        let contentType: string;
        if (format === 'pdf') {
          const orgName = (bundle.organization?.name as string) ?? 'Organisation';
          const reportSections = bundleToReportSections(bundle);
          const generatedAt = new Date().toISOString();
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
          });
          try {
            if (layout === 'separate') {
              // One PDF per section, zipped.
              const zip = new JSZip();
              for (const s of reportSections) {
                const pdf = await htmlToPdf(browser, renderSectionHtml(orgName, s, generatedAt));
                zip.file(`${s.key}.pdf`, pdf);
              }
              zip.file(
                'README.txt',
                `ALIGNED / Hader data export — formal reports\nExported: ${generatedAt}\nOne PDF per section.`,
              );
              body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
              ext = 'zip';
              contentType = 'application/zip';
            } else {
              // One combined PDF.
              body = await htmlToPdf(browser, renderCombinedHtml(orgName, reportSections, generatedAt));
              ext = 'pdf';
              contentType = 'application/pdf';
            }
          } finally {
            await browser.close().catch(() => undefined);
          }
        } else {
          // CSV — ZIP of spreadsheets (one per data type).
          body = await buildCsvZip(bundle);
          ext = 'zip';
          contentType = 'application/zip';
        }

        const storageKey = `exports/${organizationId}/${exportId}.${ext}`;
        const bytes = await putObject({ storageKey, body, contentType });

        await withRlsBypass((tx) =>
          tx.dataExport.update({
            where: { id: exportId },
            data: {
              status: 'succeeded',
              storageKey,
              fileSizeBytes: bytes,
              finishedAt: new Date(),
            },
          }),
        );

        // Email notification — link drops the user back into the portal,
        // which mints a signed URL when they click "Download". We don't
        // embed the signed URL in email because email may be retained
        // longer than the URL's lifetime.
        const downloadUrl = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/settings/data-export`;
        const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
        const fileDesc =
          format === 'pdf'
            ? layout === 'separate'
              ? 'formal PDF reports in a .zip'
              : 'a formal PDF report'
            : 'CSV files in a .zip';
        const subject = 'Your data export is ready';
        const text = `Your data export is ready (${sizeMb} MB, ${fileDesc}).\n\nDownload from the portal: ${downloadUrl}\n\nThis email is sent to admins of the organization that requested the export.`;
        const html = `
          <p>Your data export is ready.</p>
          <p><strong>Size:</strong> ${sizeMb} MB (${fileDesc})</p>
          <p><a href="${downloadUrl}">Download from the portal</a></p>
          <p style="color:#64748b;font-size:12px;margin-top:24px">Download links are short-lived and minted on demand. If the link expires, request a new one from the same page.</p>
        `;

        try {
          await sendEmail({ to: requestedByEmail, subject, text, html });
        } catch (err) {
          // Email delivery failures shouldn't fail the export — the row
          // is already 'succeeded' and the user can find it in the
          // portal regardless. Log loudly for ops.
          // eslint-disable-next-line no-console
          console.error('[data-export] email send failed', err);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'export failed';
        await withRlsBypass((tx) =>
          tx.dataExport.update({
            where: { id: exportId },
            data: { status: 'failed', finishedAt: new Date(), errorMessage: message },
          }),
        ).catch(() => undefined);
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: env.DATA_EXPORT_CONCURRENCY,
    },
  );
}

// Re-export for convenience so the worker entry doesn't need to know about prisma.
export { prisma };
