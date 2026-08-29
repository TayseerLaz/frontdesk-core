// Formal PDF report renderer for the data export — Hader-themed, editorial.
//
// Rendered HTML → PDF via the same Chromium (Playwright) the crawler ships, so
// we get full CSS control. Deliberately NOT wide tables (they overflow A4 and
// cramp the text): each record is a titled block with wrapping label/value
// pairs and long text flows as paragraphs, so everything fits and reads like a
// prepared document. Hader brand: Oxblood + Sand + cream, Fraunces display +
// Plus Jakarta Sans body + JetBrains Mono for IDs / prices.
//
// Two layouts:
//   combined → one PDF with every selected section.
//   separate → one PDF per section (the worker zips them).
import type { Browser } from 'playwright';

// ---- Brand tokens (Hader AI brand book) -----------------------------------
const OXBLOOD = '#360516';
const SAND = '#cfc0a9';
const CREAM = '#faf9f5';
const INK = '#1a1418';
const MUTED = '#8a7f84';
const RULE = '#e8e0da';

// Fields hidden from the human-facing report (noise / internal).
const HIDDEN = new Set([
  'embedding',
  'embeddingHash',
  'embedding_hash',
  'searchText',
  'search_text',
  'organizationId',
  'organization_id',
  'id',
  'createdById',
  'keyHash',
]);
// Long-form fields rendered as a full-width paragraph rather than a grid cell.
const LONGTEXT = new Set([
  'about',
  'description',
  'shortDescription',
  'answer',
  'content',
  'notes',
  'note',
  'body',
  'persona',
  'tagline',
  'customPersonality',
  'adminSystemPromptAppend',
  'greeting',
]);
// Rendered in the monospace face (identifiers / codes).
const MONO = new Set(['sku', 'phoneE164', 'phone', 'callUuid', 'metaMessageId', 'prefix', 'ref', 'paymentRef']);
// Candidate title fields, in priority order, for a record's heading.
const TITLE_FIELDS = [
  'name',
  'displayName',
  'legalName',
  'title',
  'question',
  'label',
  'sku',
  'phoneE164',
  'kind',
  'email',
  'action',
];

const MAX_RECORDS = 200;
const THREE_DEC = new Set(['KWD', 'BHD', 'OMR', 'JOD']);

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function humanize(key: string): string {
  return key
    .replace(/Minor$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\burl\b/gi, 'URL')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function moneyStr(minor: number, currency: string): string {
  const div = THREE_DEC.has(currency) ? 1000 : 100;
  const dec = THREE_DEC.has(currency) ? 3 : 2;
  const n = minor / div;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })} ${currency}`;
}

function fmtValue(key: string, v: unknown, row: Record<string, unknown>): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  if (typeof v === 'bigint') v = Number(v);
  // Money fields stored in minor units → format with the row's currency.
  if (/Minor$/.test(key) && typeof v === 'number') {
    const cur = (row.currency as string) || 'USD';
    return moneyStr(v, cur);
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    // Arrays of {name}/{title} relations → comma-joined labels; else JSON.
    return v
      .map((x) => {
        if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>;
          for (const nk of ['name', 'title', 'label', 'tag']) {
            if (typeof o[nk] === 'string') return o[nk] as string;
          }
          return JSON.stringify(x);
        }
        return String(x);
      })
      .join(', ');
  }
  if (typeof v === 'object') {
    // Unwrap a related object ({name}/{title}/{label}) to its label instead of
    // dumping raw JSON (e.g. category {"name":"El Abtal"} → "El Abtal").
    const o = v as Record<string, unknown>;
    for (const nk of ['name', 'title', 'label']) {
      if (typeof o[nk] === 'string') return o[nk] as string;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16).replace('T', ' ');
  return s;
}

function pickTitle(row: Record<string, unknown>, index: number): string {
  for (const f of TITLE_FIELDS) {
    const val = row[f];
    if (val !== null && val !== undefined && String(val).trim() !== '') return String(val);
  }
  return `Record ${index + 1}`;
}

function renderRecord(row: Record<string, unknown>, index: number): string {
  const title = esc(pickTitle(row, index));
  const grid: string[] = [];
  const paras: string[] = [];
  const titleKeyUsed = TITLE_FIELDS.find((f) => row[f] !== null && row[f] !== undefined && String(row[f]).trim() !== '');
  for (const [k, v] of Object.entries(row)) {
    if (HIDDEN.has(k)) continue;
    if (k === titleKeyUsed) continue; // already shown as the heading
    const val = fmtValue(k, v, row);
    if (!val) continue;
    if (LONGTEXT.has(k)) {
      paras.push(`<div class="para"><span class="k">${esc(humanize(k))}</span><p>${esc(val)}</p></div>`);
    } else {
      const mono = MONO.has(k) ? ' mono' : '';
      grid.push(`<div class="field${mono}"><span class="k">${esc(humanize(k))}</span><span class="v">${esc(val)}</span></div>`);
    }
  }
  return `
    <article class="record">
      <h4 class="record-title">${title}</h4>
      ${grid.length ? `<div class="fields">${grid.join('')}</div>` : ''}
      ${paras.join('')}
    </article>`;
}

export interface ReportTable {
  title: string;
  rows: Record<string, unknown>[];
}
export interface ReportSection {
  key: string;
  label: string;
  tables: ReportTable[];
}

function renderDataset(t: ReportTable): string {
  const shown = t.rows.slice(0, MAX_RECORDS);
  const trunc =
    t.rows.length > MAX_RECORDS
      ? `<p class="note">Showing ${MAX_RECORDS} of ${t.rows.length} entries — export as CSV for the complete list.</p>`
      : '';
  return `
    <div class="dataset">
      <div class="dataset-head"><h3>${esc(t.title)}</h3><span class="pill">${t.rows.length}</span></div>
      ${shown.map((r, i) => renderRecord(r, i)).join('')}
      ${trunc}
    </div>`;
}

function renderSectionBody(s: ReportSection): string {
  return `<section class="doc-section"><h2>${esc(s.label)}</h2>${s.tables.map(renderDataset).join('')}</section>`;
}

// ---- Data mapping (bundle → ordered sections of datasets) -----------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bundleToReportSections(b: any): ReportSection[] {
  const products: any[] = b.products ?? [];
  const services: any[] = b.services ?? [];
  const clients: any[] = b.clients ?? [];
  const threads: any[] = b.threads ?? [];

  const raw: ReportSection[] = [
    {
      key: 'business_info',
      label: 'Business Information',
      tables: [
        { title: 'Business profile', rows: b.businessInfo ? [b.businessInfo] : [] },
        { title: 'Locations', rows: b.locations ?? [] },
        { title: 'Contact channels', rows: b.contactChannels ?? [] },
      ],
    },
    {
      key: 'products',
      label: 'Products',
      tables: [
        { title: 'Products', rows: products.map(({ variants: _v, images: _i, ...rest }) => rest) },
        {
          title: 'Variants',
          rows: products.flatMap((p) => (p.variants ?? []).map((v: any) => ({ product: p.name, ...v }))),
        },
        { title: 'Categories', rows: b.categories ?? [] },
      ],
    },
    {
      key: 'services',
      label: 'Services',
      tables: [
        { title: 'Services', rows: services.map(({ pricingTiers: _t, availability: _a, ...rest }) => rest) },
        {
          title: 'Pricing tiers',
          rows: services.flatMap((s) => (s.pricingTiers ?? []).map((t: any) => ({ service: s.name, ...t }))),
        },
      ],
    },
    {
      key: 'faqs_policies',
      label: 'FAQs & Policies',
      tables: [
        { title: 'FAQs', rows: b.faqs ?? [] },
        { title: 'Policies', rows: b.policies ?? [] },
      ],
    },
    {
      key: 'contacts',
      label: 'Clients',
      tables: [{ title: 'Clients', rows: clients.map(({ tags: _tg, ...rest }) => rest) }],
    },
    { key: 'segments', label: 'Segments', tables: [{ title: 'Segments', rows: b.segments ?? [] }] },
    {
      key: 'broadcasts',
      label: 'Broadcasts',
      tables: [
        { title: 'Campaigns', rows: b.broadcasts ?? [] },
        { title: 'Recipients', rows: b.broadcastRecipients ?? [] },
      ],
    },
    {
      key: 'orders',
      label: 'Orders',
      tables: [
        { title: 'Orders', rows: b.carts ?? [] },
        { title: 'Order items', rows: b.cartItems ?? [] },
      ],
    },
    { key: 'bookings', label: 'Bookings', tables: [{ title: 'Bookings', rows: b.bookings ?? [] }] },
    {
      key: 'conversations',
      label: 'Conversations',
      tables: [
        { title: 'Threads', rows: threads.map(({ tags: _tg, ...rest }) => rest) },
        { title: 'Messages', rows: b.messages ?? [] },
      ],
    },
    { key: 'members', label: 'Team Members', tables: [{ title: 'Members', rows: b.members ?? [] }] },
    { key: 'activity', label: 'Activity Log', tables: [{ title: 'Audit entries', rows: b.audit ?? [] }] },
    {
      key: 'ai',
      label: 'AI Configuration',
      tables: [
        { title: 'Bot configuration', rows: b.botConfig ? [b.botConfig] : [] },
        { title: 'Knowledge base', rows: b.kb ?? [] },
      ],
    },
    { key: 'api_keys', label: 'API Keys', tables: [{ title: 'API keys', rows: b.apiKeys ?? [] }] },
  ];

  return raw
    .map((s) => ({ ...s, tables: s.tables.filter((t) => t.rows && t.rows.length > 0) }))
    .filter((s) => s.tables.length > 0);
}

// ---- Document shell + cover (Hader theme) ---------------------------------
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; color: ${INK}; background: ${CREAM};
    font-family: 'Plus Jakarta Sans', -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 10px; line-height: 1.45; }
  h1,h2,h3,h4,.serif { font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 500; }

  /* Cover */
  .cover { height: 100vh; display: flex; flex-direction: column; padding: 26mm 22mm; page-break-after: always;
    background: ${CREAM}; position: relative; }
  .cover::before { content:''; position:absolute; left:0; top:0; bottom:0; width:10mm; background:${OXBLOOD}; }
  .wordmark { font-family:'Fraunces',serif; font-size: 22px; font-weight:600; letter-spacing:1px; color:${OXBLOOD}; }
  .wordmark .ai { color:${SAND}; }
  .cover-mid { margin-top: auto; margin-bottom: auto; }
  .cover .kicker { text-transform: uppercase; letter-spacing: 4px; font-size: 9px; color:${MUTED}; font-weight:700; }
  .cover h1 { font-size: 46px; line-height:1.02; margin: 10px 0 6px; color:${OXBLOOD}; font-weight:600; letter-spacing:-1px; }
  .cover .org { font-size: 16px; color:${INK}; margin: 0; }
  .cover .meta { margin-top: 26px; padding-top: 16px; border-top: 2px solid ${SAND};
    font-size: 10px; color:${INK}; line-height: 2; max-width: 120mm; }
  .cover .meta .k { display:inline-block; width: 34mm; color:${MUTED}; text-transform:uppercase; letter-spacing:1px; font-size:8px; }
  .cover .conf { font-size: 8px; color:${MUTED}; letter-spacing: 1px; text-transform:uppercase; }

  /* Contents */
  .toc { padding: 18mm 22mm; page-break-after: always; }
  .toc h2 { font-size: 20px; color:${OXBLOOD}; margin:0 0 14px; }
  .toc-item { display:flex; justify-content:space-between; align-items:baseline; padding: 7px 0; border-bottom: 1px solid ${RULE}; }
  .toc-item .t { font-size: 12px; color:${INK}; }
  .toc-item .c { font-size: 9px; color:${MUTED}; font-family:'JetBrains Mono',monospace; }

  /* Sections */
  .doc-section { page-break-before: always; padding: 16mm 22mm; }
  h2 { font-size: 26px; color:${OXBLOOD}; margin: 0 0 2px; font-weight:600; letter-spacing:-0.5px; }
  h2::after { content:''; display:block; width: 42px; height: 3px; background:${SAND}; margin-top: 8px; margin-bottom: 18px; }
  .dataset { margin-bottom: 20px; }
  .dataset-head { display:flex; align-items:center; gap:8px; margin: 4px 0 8px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.4px; color:${INK}; margin: 0; font-family:'Plus Jakarta Sans',sans-serif; font-weight:700; }
  .pill { font-family:'JetBrains Mono',monospace; font-size: 8px; color:${OXBLOOD}; background:#f0e2e6; border:1px solid #e4cdd4; border-radius: 999px; padding: 1px 7px; }

  /* Records — no tables; wrapping label/value blocks */
  .record { padding: 10px 12px; margin-bottom: 6px; background:#fff; border:1px solid ${RULE}; border-left: 2px solid ${SAND};
    border-radius: 3px; break-inside: avoid; }
  .record-title { font-size: 13px; color:${OXBLOOD}; margin: 0 0 7px; font-weight:600; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 22px; }
  .field { display:flex; flex-direction:column; min-width:0; }
  .field .k { font-size: 7px; text-transform: uppercase; letter-spacing: 0.7px; color:${MUTED}; font-weight:700; margin-bottom:1px; }
  .field .v { font-size: 9.5px; color:${INK}; word-break: break-word; overflow-wrap: anywhere; }
  .field.mono .v { font-family:'JetBrains Mono',monospace; font-size: 8.5px; color:#4a3f45; }
  .para { grid-column:1/-1; margin-top: 7px; }
  .para .k { font-size: 7px; text-transform: uppercase; letter-spacing: 0.7px; color:${MUTED}; font-weight:700; display:block; margin-bottom:2px; }
  .para p { margin: 0; font-size: 9.5px; line-height: 1.55; color:${INK}; white-space: pre-wrap; word-break: break-word; }
  .note { font-size: 8.5px; color:${MUTED}; font-style: italic; margin: 6px 2px 0; }
`;

function docShell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${inner}</body></html>`;
}

function coverPage(orgName: string, title: string, generatedAtIso: string, sectionLabels: string[]): string {
  const date = new Date(generatedAtIso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `
    <div class="cover">
      <div class="wordmark">Hader<span class="ai"> AI</span></div>
      <div class="cover-mid">
        <div class="kicker">Data Export Report</div>
        <h1>${esc(title)}</h1>
        <p class="org">Prepared for ${esc(orgName)}</p>
        <div class="meta">
          <div><span class="k">Organisation</span> ${esc(orgName)}</div>
          <div><span class="k">Date</span> ${esc(date)}</div>
          <div><span class="k">Sections</span> ${esc(sectionLabels.join(' · '))}</div>
          <div><span class="k">Produced by</span> Hader · ALIGNED platform</div>
        </div>
      </div>
      <div class="conf">Confidential — contains business &amp; customer data. Handle per your data-protection obligations.</div>
    </div>`;
}

/** One combined document with every section. */
export function renderCombinedHtml(orgName: string, sections: ReportSection[], generatedAtIso: string): string {
  const toc = `
    <div class="toc"><h2>Contents</h2>${sections
      .map((s) => {
        const rows = s.tables.reduce((n, t) => n + t.rows.length, 0);
        return `<div class="toc-item"><span class="t">${esc(s.label)}</span><span class="c">${rows} entries</span></div>`;
      })
      .join('')}</div>`;
  const body = sections.map(renderSectionBody).join('');
  return docShell(
    coverPage(orgName, 'Business Data Report', generatedAtIso, sections.map((s) => s.label)) + toc + body,
  );
}

/** A single-section document. */
export function renderSectionHtml(orgName: string, section: ReportSection, generatedAtIso: string): string {
  return docShell(
    coverPage(orgName, section.label, generatedAtIso, [section.label]) + renderSectionBody(section),
  );
}

/** Render an HTML string to a PDF Buffer using a shared Chromium browser. */
export async function htmlToPdf(browser: Browser, html: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    // Give the brand webfonts a chance to load so the PDF isn't rendered in the
    // fallback stack. Resolves even if the network font fails (falls back). The
    // string form avoids referencing the DOM `document` in the worker's TS scope.
    await page.evaluate('document.fonts ? document.fonts.ready : true').catch(() => undefined);
    const footer = `
      <div style="width:100%;font-size:7px;color:#8a7f84;padding:0 22mm;display:flex;justify-content:space-between;font-family:sans-serif;">
        <span>Hader · ALIGNED — Confidential</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`;
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '10mm', bottom: '14mm', left: '0mm', right: '0mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
