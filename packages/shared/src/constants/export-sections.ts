// Data-export sections. Single source of truth shared by the admin export API
// (validates the requested section keys), the export worker (only gathers +
// writes the selected sections), and the admin UI (renders the pick-what-you-
// want checklist). Add a new dataset here once and all three stay in sync.
//
// An EMPTY selection means "everything" — that's what the tenant self-service
// export (POST /exports with no body) sends, so it stays a full portability
// export. The admin UI always sends an explicit selection.

export interface ExportSection {
  /** Stable key stored on DataExport.sections + sent by the UI. */
  key: string;
  /** Human label in the checklist. */
  label: string;
  /** UI grouping header. */
  group: string;
  /** Pre-checked in the dialog. Heavy / PII / sensitive sections default off. */
  defaultOn: boolean;
  /** One-line hint under the label. */
  description: string;
  /** CSV filenames this section produces (documentation only). */
  files: string[];
}

export const EXPORT_SECTIONS: ExportSection[] = [
  // ---- Business -----------------------------------------------------------
  {
    key: 'business_info',
    label: 'Business info',
    group: 'Business',
    defaultOn: true,
    description: 'Profile, opening hours, locations, contact channels.',
    files: ['business_info.csv', 'locations.csv', 'contact_channels.csv'],
  },
  {
    key: 'products',
    label: 'Products',
    group: 'Business',
    defaultOn: true,
    description: 'Products with variants, images and categories.',
    files: ['products.csv', 'product_variants.csv', 'product_images.csv', 'categories.csv'],
  },
  {
    key: 'services',
    label: 'Services',
    group: 'Business',
    defaultOn: true,
    description: 'Services with pricing tiers and weekly availability.',
    files: ['services.csv', 'service_pricing_tiers.csv', 'service_availability.csv'],
  },
  {
    key: 'faqs_policies',
    label: 'FAQs & policies',
    group: 'Business',
    defaultOn: true,
    description: 'Published FAQs and policy documents.',
    files: ['faqs.csv', 'policies.csv'],
  },
  // ---- Clients ------------------------------------------------------------
  {
    key: 'contacts',
    label: 'Clients / contacts',
    group: 'Clients',
    defaultOn: true,
    description: 'Customer list with opt-in/out, block status and tags.',
    files: ['clients.csv', 'client_tags.csv'],
  },
  {
    key: 'segments',
    label: 'Segments',
    group: 'Clients',
    defaultOn: true,
    description: 'Saved audiences and their filter definitions.',
    files: ['segments.csv'],
  },
  // ---- Outreach -----------------------------------------------------------
  {
    key: 'broadcasts',
    label: 'Broadcasts',
    group: 'Outreach',
    defaultOn: true,
    description: 'Campaigns with per-recipient delivery results and events.',
    files: ['broadcasts.csv', 'broadcast_recipients.csv', 'broadcast_events.csv'],
  },
  // ---- Commerce -----------------------------------------------------------
  {
    key: 'orders',
    label: 'Orders / carts',
    group: 'Commerce',
    defaultOn: true,
    description: 'Orders captured by the bot with their line items.',
    files: ['orders.csv', 'order_items.csv'],
  },
  {
    key: 'bookings',
    label: 'Bookings',
    group: 'Commerce',
    defaultOn: true,
    description: 'Appointment / booking requests.',
    files: ['bookings.csv'],
  },
  // ---- Conversations ------------------------------------------------------
  {
    key: 'conversations',
    label: 'Conversations',
    group: 'Conversations',
    defaultOn: false,
    description: 'Full WhatsApp / Messenger / IG threads + messages. Large + contains PII.',
    files: ['conversation_threads.csv', 'conversation_messages.csv', 'conversation_notes.csv'],
  },
  // ---- Team & activity ----------------------------------------------------
  {
    key: 'members',
    label: 'Team members',
    group: 'Team & activity',
    defaultOn: true,
    description: 'Org members with role, status and email.',
    files: ['members.csv'],
  },
  {
    key: 'activity',
    label: 'Activity log',
    group: 'Team & activity',
    defaultOn: true,
    description: 'Last 5,000 audit-log entries.',
    files: ['audit_log.csv'],
  },
  // ---- AI -----------------------------------------------------------------
  {
    key: 'ai',
    label: 'AI config',
    group: 'AI',
    defaultOn: true,
    description: 'Bot config (incl. admin prompt addendum) + knowledge base.',
    files: ['bot_config.csv', 'bot_knowledge_base.csv'],
  },
  {
    key: 'api_keys',
    label: 'API keys (metadata)',
    group: 'AI',
    defaultOn: false,
    description: 'Key names, scopes and status. Never includes the secret.',
    files: ['api_keys.csv'],
  },
];

export const EXPORT_SECTION_KEYS: string[] = EXPORT_SECTIONS.map((s) => s.key);
export const DEFAULT_EXPORT_SECTIONS: string[] = EXPORT_SECTIONS.filter((s) => s.defaultOn).map(
  (s) => s.key,
);

/** True when a section should be included given the requested selection.
 *  An empty selection means "everything" (full portability export). */
export function exportWants(selection: string[] | null | undefined, key: string): boolean {
  return !selection || selection.length === 0 || selection.includes(key);
}

// ---- Output format + layout ------------------------------------------------
// `csv`  = spreadsheets, one CSV per data type in a .zip (best for re-importing).
// `pdf`  = a formal, formatted report document (best for sharing / presenting).
export type ExportFormat = 'csv' | 'pdf';
export const EXPORT_FORMATS: { key: ExportFormat; label: string; description: string }[] = [
  { key: 'csv', label: 'Spreadsheets (CSV)', description: 'One CSV per data type in a .zip. Best for data + re-importing.' },
  { key: 'pdf', label: 'Formal report (PDF)', description: 'A clean, formatted document with headings and tables. Best for sharing.' },
];

// `combined` = one document/file. `separate` = one document per section (zipped).
// Layout only changes the PDF output; CSV is always one file per data type.
export type ExportLayout = 'combined' | 'separate';
export const EXPORT_LAYOUTS: { key: ExportLayout; label: string; description: string }[] = [
  { key: 'combined', label: 'One combined report', description: 'Everything in a single document.' },
  { key: 'separate', label: 'Separate reports', description: 'One document per section, delivered in a .zip.' },
];

export const EXPORT_FORMAT_KEYS: string[] = EXPORT_FORMATS.map((f) => f.key);
export const EXPORT_LAYOUT_KEYS: string[] = EXPORT_LAYOUTS.map((l) => l.key);
