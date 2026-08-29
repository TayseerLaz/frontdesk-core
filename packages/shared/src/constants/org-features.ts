// super-admin per-tenant access control.
//
// Each feature maps to a set of portal routes (hidden + route-guarded when
// disabled). The 'ai' feature additionally turns off the bot's auto-reply, so
// a tenant becomes a pure social-media handler answered manually from the inbox.
// Disabling a feature is stored in Organization.disabledFeatures (a list of the
// keys below). Empty list = full access.
export const ORG_FEATURES = [
  {
    key: 'ai',
    label: 'AI auto-reply + bot builder',
    description:
      'The AI answers customers automatically. Turn OFF to make this tenant a social-media handler with MANUAL replies only (the inbox still works; the bot stays silent). Also hides the AI bot builder page.',
    hrefs: ['/bot'],
  },
  {
    key: 'products',
    label: 'Products',
    description: 'The Products catalog and the Categories page.',
    hrefs: ['/products', '/categories'],
  },
  {
    key: 'services',
    label: 'Services',
    description: 'The Services catalog page.',
    hrefs: ['/services'],
  },
  {
    key: 'business_info',
    label: 'Business info',
    description: 'Business profile, hours, locations, contacts, FAQs and policies.',
    hrefs: ['/business-info'],
  },
  {
    key: 'imports',
    label: 'Imports',
    description: 'CSV/XLSX bulk imports (products, services, FAQs, business info).',
    hrefs: ['/imports'],
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts & templates',
    description: 'WhatsApp broadcast campaigns + message templates.',
    hrefs: ['/broadcasts'],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    description: 'The contact list (CRM).',
    hrefs: ['/contacts'],
  },
  {
    key: 'orders',
    label: 'Orders / cart',
    description: 'The orders (cart) page where WhatsApp/Messenger orders land.',
    hrefs: ['/cart'],
  },
  {
    key: 'bookings',
    label: 'Bookings',
    description: 'The appointment bookings page.',
    hrefs: ['/bookings'],
  },
  {
    key: 'messenger',
    label: 'Facebook Messenger',
    description:
      'Let the bot answer Facebook Messenger DMs. Turn OFF to silence Messenger (DMs still land in the inbox; the bot stays silent and operators can’t reply on it). Does not affect WhatsApp or Instagram.',
    // No page to hide — Messenger + Instagram share the /settings/messenger
    // config page, so gating is enforced at the channel level (bot reply +
    // operator send + inbox filter), not by hiding a route.
    hrefs: [],
  },
  {
    key: 'instagram',
    label: 'Instagram Direct',
    description:
      'Let the bot answer Instagram DMs. Turn OFF to silence Instagram only (Messenger stays active if enabled separately).',
    hrefs: [],
  },
  {
    key: 'phone',
    label: 'Phone / voice integration',
    description:
      'The AI voicebot answers phone calls (Aseer-time phone bridge). Turn OFF to disable the phone bot and hide the Phone integration + Voice calls pages — the voicebot stops receiving this tenant’s persona/config.',
    hrefs: ['/phone-integrations', '/voice-calls'],
  },
  {
    key: 'exports',
    label: 'Data export',
    description:
      'Self-service GDPR data export (the /settings/data-export page). Turn OFF to remove it for the tenant — super-admins can still export this org’s data from the admin panel at any time.',
    hrefs: ['/settings/data-export'],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    description: 'The analytics dashboard.',
    hrefs: ['/analytics'],
  },
  {
    key: 'inbox',
    label: 'Inbox & canned replies',
    description:
      'The conversation inbox + canned replies. Disable for accounts that should not handle conversations at all (e.g. an admin-only HQ).',
    hrefs: ['/inbox', '/inbox-full'],
  },
  {
    key: 'shopify',
    label: 'Shopify sync',
    description:
      'Connect a Shopify store to scrape products, customers, business info and policies into the platform (with a review + approve step) and keep them in sync. Opt-in: OFF by default for every tenant — enable it only for stores on a Shopify plan.',
    hrefs: ['/settings/shopify'],
    // Opt-in feature: new orgs start with this DISABLED. See ORG_FEATURE_DEFAULT_DISABLED.
    defaultDisabled: true,
  },
  {
    key: 'voice_transcription',
    label: 'Voice note transcription',
    description:
      'Automatically transcribe inbound WhatsApp voice notes with Whisper so the inbox shows the text (and the bot can answer them). Incurs a per-note transcription cost. Turn OFF to keep voice notes playable but skip transcription. ON by default.',
    // No page to hide — this gates the inbound transcription path only.
    hrefs: [],
  },
  {
    key: 'contact_memory',
    label: 'AI contact memory',
    description:
      "The bot builds a short profile ('user info') of each contact from their conversations and uses it to personalise replies. Turn OFF to stop generating and using per-contact AI memory (saves AI cost). ON by default.",
    // No page to hide — this gates the per-contact persona generation + use.
    hrefs: [],
  },
  {
    key: 'sales_scan',
    label: 'Teach the bot with your own data',
    description:
      "Let the tenant link the sales WhatsApp number they already use, capture one week of their real customer conversations (both directions), then show them a summary of those chats and an analysis of how they speak. Opt-in: OFF by default — an super-admin enables it per tenant once the upgrade is agreed.",
    // Gated like every other paged feature: hidden when off, visible when on.
    //
    // This used to be the ONE exception — `hrefs: []` kept the Settings card visible
    // to tenants without the feature so it could show "contact admin to upgrade".
    // That was reversed on 2026-08-05 by owner decision; do not reintroduce it.
    // Listing the href here is what lets isHrefDisabled() hide the card and bounce
    // the route in apps/web/src/app/(dashboard)/layout.tsx.
    //
    // NOTE the bounce is a client-side useEffect, not a boundary — the API's
    // assertOrgFeature calls remain the enforcement. The two REVOCATION routes
    // (stop capture, delete captured data) are deliberately NOT gated, so a tenant
    // whose feature is switched off mid-window can still withdraw consent; see the
    // header of apps/api/src/modules/sales-scan/sales-scan.routes.ts.
    hrefs: ['/settings/sales-scan'],
    // Opt-in: new orgs start DISABLED; existing orgs backfilled by
    // migrations/20260730121000_backfill_sales_scan_feature.
    defaultDisabled: true,
  },
  {
    key: 'stock_watch',
    label: 'Back-in-stock alerts',
    description:
      'When a customer asks the bot about an out-of-stock product or service, they are flagged automatically (visible on their contact profile); when it comes back in stock, they get a WhatsApp notification — free text inside the 24h window, otherwise via the approved back_in_stock template. Respects opt-outs and wallet metering. Opt-in: OFF by default — an super-admin enables it per tenant.',
    // Surfaces live on the contact profile + product pages — no dedicated
    // route to hide; capture + tick both re-check this flag per org.
    hrefs: [],
    // Opt-in: new orgs start DISABLED; existing orgs backfilled by
    // migrations/20260828130100_backfill_stock_watch_feature.
    defaultDisabled: true,
  },
  {
    key: 'inbox_teamwork',
    label: 'Inbox teamwork (assignment & alerts)',
    description:
      'Mine/Unassigned inbox tabs, assign-to-teammate menu, admin takeover of an assigned chat, assignment permission rules, and the assigned-to-you notification + sound. Opt-in: OFF by default — an super-admin enables it per tenant.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'contact_sap',
    label: 'Contact SAP / ERP numbers',
    description:
      'SAP # column on contacts (unique per org), editable inline and on Add contact; CSV imports merge by SAP # first, phone second. Opt-in: OFF by default.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'website_connector',
    label: 'Website product-feed wizard',
    description:
      'The guided "Connect your website" wizard on API connectors: fetch a sample from a products API, visually map fields with a live preview, schedule syncs. Opt-in: OFF by default.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'quick_buttons',
    label: 'Configurable quick buttons',
    description:
      'Operator-defined tappable buttons under AI replies (guaranteed on every reply) with optional instant canned answers. Opt-in: OFF by default.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'analytics_v2',
    label: 'Analytics v2 (AI & team performance)',
    description:
      'AI containment rate, AI-vs-team reply split, CSAT with handler split, per-agent stats, sales by channel, 90-day window and CSV export on the Analytics page. Opt-in: OFF by default.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'page_permissions',
    label: 'Per-member page access',
    description:
      'Admins choose which pages each editor/viewer can open (invite-time and on the Members page). Existing members keep full access until restricted. Opt-in: OFF by default.',
    hrefs: [],
    // Opt-in: backfilled by migrations/20260829130000_hide_roadmap_features.
    defaultDisabled: true,
  },
  {
    key: 'feedback',
    label: 'Conversation feedback (CSAT)',
    description:
      'After an operator resolves a WhatsApp conversation, the customer is asked to rate it 1-5 (within the 24h session window only). Ratings are stored with an AI-vs-human handler split for reporting. Opt-in: OFF by default — an super-admin enables it per tenant, then the tenant turns it on in the AI bot builder.',
    // The config card lives on /bot, which every tenant has — no dedicated
    // route to hide; the card self-gates on the session's disabledFeatures.
    hrefs: [],
    // Opt-in: new orgs start DISABLED; existing orgs backfilled by
    // migrations/20260827140100_backfill_feedback_feature.
    defaultDisabled: true,
  },
  {
    key: 'follow_ups',
    label: 'Automated follow-ups',
    description:
      'Automated WhatsApp template follow-ups: chase customers who inquired but went silent (24h/72h no-reply cadence), post-booking check-ins after appointments, and casual re-engagement of idle customers. Every send uses an approved Meta template and respects opt-outs. Opt-in: OFF by default — an super-admin enables it per tenant.',
    // The config card lives on /bot (bot behaviour), which every tenant has —
    // no dedicated route to hide, so the card self-gates on the session's
    // disabledFeatures and the worker tick re-checks the flag per org.
    hrefs: [],
    // Opt-in: new orgs start DISABLED; existing orgs backfilled by
    // migrations/20260814130100_backfill_follow_ups_feature.
    defaultDisabled: true,
  },
] as const;

export type OrgFeatureKey = (typeof ORG_FEATURES)[number]['key'];

export const ORG_FEATURE_KEYS = ORG_FEATURES.map((f) => f.key) as OrgFeatureKey[];

/**
 * Opt-in features: keys that should be DISABLED by default for every org (new
 * tenants start with these in `disabledFeatures`; existing orgs are backfilled
 * by the feature's migration). An super-admin enables them per tenant.
 */
export const ORG_FEATURE_DEFAULT_DISABLED = ORG_FEATURES.filter(
  (f) => 'defaultDisabled' in f && f.defaultDisabled,
).map((f) => f.key) as OrgFeatureKey[];

/** True if `href` belongs to a feature that's in the disabled list. */
// ============================================================================
// F1 (roadmap 2026-08-26) — per-member PAGE ACCESS.
//
// Vocabulary = the feature keys above (their hrefs) PLUS the core pages no
// feature key covers. ONE registry: a new gated feature automatically becomes
// a grantable page. Semantics on Membership.pageAccess (JSONB):
//   null  = full access for the member's role (backward compatible — no
//           backfill, nothing changes for existing members)
//   []    = no listed pages (dashboard + profile always remain reachable)
//   [...] = whitelist of page keys from this registry
// Admins are ALWAYS exempt (prevents lock-out; restrict someone by making
// them editor/viewer first). Never derive anything from a key's absence in
// the REGISTRY — an unlisted href is simply not restrictable (fails to the
// role check, never open-endedly blocked).

export const CORE_PAGE_ACCESS = [
  { key: 'members', label: 'Team members', hrefs: ['/members'] },
  { key: 'whatsapp_settings', label: 'WhatsApp numbers', hrefs: ['/whatsapp'] },
  { key: 'sequences', label: 'Sequences', hrefs: ['/sequences'] },
  { key: 'segments', label: 'Segments', hrefs: ['/segments'] },
  { key: 'api_tools', label: 'API keys, webhooks & connectors', hrefs: ['/api-keys', '/webhooks', '/connectors'] },
  { key: 'billing', label: 'Billing', hrefs: ['/billing'] },
  { key: 'settings', label: 'Settings', hrefs: ['/settings'] },
] as const;

export interface PageAccessOption {
  key: string;
  label: string;
  hrefs: readonly string[];
}

/** Every grantable page: gated features that own routes + the core pages. */
export function pageAccessOptions(): PageAccessOption[] {
  return [
    ...ORG_FEATURES.filter((f) => f.hrefs.length > 0).map((f) => ({
      key: f.key,
      label: f.label,
      hrefs: f.hrefs,
    })),
    ...CORE_PAGE_ACCESS,
  ];
}

/** Defensive parse of the Membership.pageAccess JSONB. null = full access. */
export function parsePageAccess(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null; // corrupt shape → fail toward role
  return raw.filter((v): v is string => typeof v === 'string').slice(0, 64);
}

/** Web-side gate: is this href blocked by the member's page whitelist? */
export function isHrefBlockedByPageAccess(href: string, pageAccess: string[] | null): boolean {
  if (pageAccess == null) return false;
  // A member's OWN profile (password, 2FA) is a personal security surface —
  // always reachable, even under an empty whitelist. The rest of /settings
  // stays restrictable via the 'settings' key.
  if (href === '/settings/profile' || href.startsWith('/settings/profile/')) return false;
  const owner = pageAccessOptions().find((p) =>
    p.hrefs.some((h) => href === h || href.startsWith(`${h}/`)),
  );
  if (!owner) return false; // un-registered pages (dashboard, profile) always pass
  return !pageAccess.includes(owner.key);
}

// API-side gate: which page key owns an API path. DELIBERATELY explicit and
// conservative — unmapped paths fall through to the role check alone. Note
// /api/v1/whatsapp is NOT mapped wholesale (the inbox reply path sends through
// /whatsapp/send); only the number-management prefix belongs to the
// whatsapp_settings page.
const API_PREFIX_PAGE_KEYS: [prefix: string, key: string][] = [
  ['/api/v1/products', 'products'],
  ['/api/v1/categories', 'products'],
  ['/api/v1/services', 'services'],
  ['/api/v1/business-info', 'business_info'],
  ['/api/v1/imports', 'imports'],
  ['/api/v1/broadcasts', 'broadcasts'],
  ['/api/v1/segments', 'segments'],
  ['/api/v1/sequences', 'sequences'],
  ['/api/v1/contacts', 'contacts'],
  ['/api/v1/stock-watches', 'contacts'],
  ['/api/v1/inbox', 'inbox'],
  ['/api/v1/carts', 'orders'],
  ['/api/v1/bookings', 'bookings'],
  ['/api/v1/analytics', 'analytics'],
  ['/api/v1/billing', 'billing'],
  ['/api/v1/api-keys', 'api_tools'],
  ['/api/v1/webhooks', 'api_tools'],
  ['/api/v1/connectors', 'api_tools'],
  ['/api/v1/bot', 'ai'],
  ['/api/v1/members', 'members'],
  ['/api/v1/whatsapp/numbers', 'whatsapp_settings'],
];

export function apiPathPageKey(path: string): string | null {
  const clean = path.split('?')[0] ?? path;
  for (const [prefix, key] of API_PREFIX_PAGE_KEYS) {
    if (clean === prefix || clean.startsWith(`${prefix}/`) || clean.startsWith(`${prefix}?`)) {
      return key;
    }
  }
  return null;
}

export function isHrefDisabled(href: string, disabled: string[]): boolean {
  if (disabled.length === 0) return false;
  return ORG_FEATURES.some(
    (f) =>
      disabled.includes(f.key) &&
      f.hrefs.some((h) => href === h || href.startsWith(`${h}/`)),
  );
}
