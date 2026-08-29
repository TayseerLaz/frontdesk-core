// Real-data client for the dashboard widgets. One function per widget,
// each calling its dedicated /api/v1/dashboard/widgets/* endpoint and
// returning a view-model the matching widget renders directly.
//
// Subtext strings (e.g. "3 missing price/photo") + tone classification
// live here, not on the server, so localisation + UX tweaks don't
// require an API redeploy. The server returns raw numbers; this layer
// turns them into the words the operator reads.

import { api } from './api';

// ---------- 1. KPI strip ---------------------------------------------------

export type KpiTone = 'warning' | 'success' | 'neutral';

export interface KpiTile {
  id: string;
  label: string;
  value: number;
  subtext: string;
  subtextTone: KpiTone;
  href: string;
  action?: { label: string; href: string };
  // When set, the warning subtext becomes a press-to-reveal hint that lists
  // the offending rows. Only populated when there's something to drill into.
  hint?: { kind: 'services-incomplete' };
}

export interface KpiStripData {
  tiles: KpiTile[];
}

interface KpiApiResponse {
  products: { total: number; incomplete: number };
  services: { total: number; incomplete: number };
  faqs: { total: number };
  contacts: { total: number; newThisWeek: number };
}

export async function getKpiStrip(): Promise<KpiStripData> {
  const res = await api.get<{ data: KpiApiResponse }>('/api/v1/dashboard/widgets/kpi');
  const d = res.data;
  return {
    tiles: [
      {
        id: 'products',
        label: 'Products',
        value: d.products.total,
        subtext:
          d.products.incomplete > 0
            ? `${d.products.incomplete} missing price/photo`
            : 'all complete',
        subtextTone: d.products.incomplete > 0 ? 'warning' : 'success',
        href: '/products',
      },
      {
        id: 'services',
        label: 'Services',
        value: d.services.total,
        subtext:
          d.services.incomplete > 0
            ? `${d.services.incomplete} missing details`
            : 'all complete',
        subtextTone: d.services.incomplete > 0 ? 'warning' : 'success',
        href: '/services',
        hint: d.services.incomplete > 0 ? { kind: 'services-incomplete' } : undefined,
      },
      {
        id: 'faqs',
        label: 'FAQs',
        value: d.faqs.total,
        subtext: d.faqs.total === 0 ? 'none yet' : 'covers top topics',
        subtextTone: d.faqs.total === 0 ? 'warning' : 'neutral',
        href: '/business-info',
      },
      {
        id: 'contacts',
        label: 'Contacts',
        value: d.contacts.total,
        subtext:
          d.contacts.newThisWeek > 0
            ? `+${d.contacts.newThisWeek} this week`
            : 'no new this week',
        subtextTone: d.contacts.newThisWeek > 0 ? 'success' : 'neutral',
        href: '/contacts',
        action: { label: 'ADD', href: '/contacts?new=1' },
      },
    ],
  };
}

// ---------- 1b. KPI drill-down: incomplete services -----------------------
// Lazily fetched when the operator opens the "N missing details" hint on the
// Services KPI tile. Tells them which services to fix and what each lacks.
// Kept out of getKpiStrip so the dashboard's first paint stays a single
// counts query — the detail list is only loaded on demand.

export type ServiceMissingField = 'description' | 'price';

export interface IncompleteService {
  id: string;
  name: string;
  missing: ServiceMissingField[];
}

export async function getIncompleteServices(): Promise<IncompleteService[]> {
  const res = await api.get<{ data: { services: IncompleteService[] } }>(
    '/api/v1/dashboard/widgets/kpi/incomplete-services',
  );
  return res.data.services;
}

// ---------- 2. Onboarding checklist ----------------------------------------

export interface OnboardingStep {
  id: string;
  label: string;
  href: string;
  completed: boolean;
}

export interface OnboardingData {
  steps: OnboardingStep[];
  complete: boolean;
}

export async function getOnboardingChecklist(): Promise<OnboardingData> {
  const res = await api.get<{ data: OnboardingData }>('/api/v1/dashboard/widgets/onboarding');
  return res.data;
}

// ---------- 3. Inbox snapshot ----------------------------------------------

export interface InboxSnapshot {
  openThreads: number;
  unassigned: number;
  awaitingReply: number;
  avgFirstResponseSeconds: number | null;
}

export async function getInboxSnapshot(): Promise<InboxSnapshot> {
  const res = await api.get<{ data: InboxSnapshot }>('/api/v1/dashboard/widgets/inbox-snapshot');
  return res.data;
}

// ---------- 4. Bot performance · today -------------------------------------

export interface BotPerformanceToday {
  autoResolvedPercent: number;
  botHandledMessages: number;
  handedToHuman: number;
  topFaq: string | null;
}

export async function getBotPerformanceToday(): Promise<BotPerformanceToday> {
  const res = await api.get<{ data: BotPerformanceToday }>('/api/v1/dashboard/widgets/bot-performance');
  return res.data;
}

// ---------- 5. Outreach & campaigns ----------------------------------------

export interface ActiveCampaign {
  id: string;
  name: string;
  status: string;
  sent: number;
  delivered: number;
  read: number;
}

export interface OutreachData {
  active: ActiveCampaign | null;
}

export async function getOutreachCampaigns(): Promise<OutreachData> {
  const res = await api.get<{ data: OutreachData }>('/api/v1/dashboard/widgets/outreach');
  return res.data;
}

// ---------- 6. AI chatbot budget · today -----------------------------------
// Reuses the long-standing /dashboard/ai-usage endpoint — no need for a
// new route here. The response shape needs a small adapter so the widget
// stays decoupled from the legacy field names.

export interface UsageQuota {
  key: string;
  label: string;
  monthly: boolean;
  used: number;
  cap: number | null; // null = unlimited
  pct: number | null;
}

export interface AiBudgetToday {
  plan: 'Unlimited' | 'Capped';
  // Tenant-facing: messages used + cap + percentage only. Tokens/cost are
  // intentionally NOT surfaced here (admin-only, on the tenant details page).
  messagesUsed: number;
  messageCap: number | null;
  messagePct: number | null;
  // Monthly AI-message allowance — the cap that PAUSES the bot when hit.
  // Drives the dashboard banner (warn at 80%, red/paused at 100%).
  percentUsed: number;
  unlimited: boolean;
  // Every other enforced limit the tenant can hit (plan messages/broadcasts/
  // imports + catalog/member/key caps) — surfaced in the "Usage & limits" widget.
  quotas: UsageQuota[];
}

interface AiUsageResponse {
  used: number;
  limit: number;
  unlimited: boolean;
  percentUsed: number;
  estCostUsd: number;
  messagesUsed: number;
  messageCap: number | null;
  messagePct: number | null;
  quotas: UsageQuota[];
}

export async function getAiBudgetToday(): Promise<AiBudgetToday> {
  const res = await api.get<{ data: AiUsageResponse }>('/api/v1/dashboard/ai-usage');
  const d = res.data;
  return {
    plan: d.unlimited ? 'Unlimited' : 'Capped',
    messagesUsed: d.messagesUsed,
    messageCap: d.messageCap,
    messagePct: d.messagePct,
    percentUsed: d.percentUsed,
    unlimited: d.unlimited,
    quotas: d.quotas ?? [],
  };
}

// ---------- 6b. WhatsApp wallet balance ------------------------------------
// Tenant-facing prepaid balance + messages remaining. Reuses the same
// /billing/overview endpoint the /billing page + banner read, so all three
// share one query cache. `metered` false = pay-as-you-go billing isn't on for
// this workspace (widget + banner hide themselves).

export interface WalletOverview {
  metered: boolean;
  availableMicros: number;
  heldMicros: number;
  pricePerMessageMicros: number;
  messagesRemaining: number;
  lowBalanceThresholdMicros: number;
  lifetimeSpentMicros: number;
  lifetimeMessages: number;
  lifetimeToppedUpMicros: number;
  alert: { pctUsed: number; level: 'ok' | 'alert' | 'empty'; message: string | null };
}

export async function getWalletOverview(): Promise<WalletOverview> {
  const res = await api.get<{ data: WalletOverview }>('/api/v1/billing/overview');
  return res.data;
}

// ---------- 7. Connections & sync ------------------------------------------

export type WebhookHealth = 'healthy' | 'degraded' | 'failing';

export interface ConnectionsData {
  lastSyncIso: string | null;
  templates: { approved: number; pending: number };
  webhooks: WebhookHealth;
}

export async function getConnectionsSync(): Promise<ConnectionsData> {
  const res = await api.get<{ data: ConnectionsData }>('/api/v1/dashboard/widgets/connections-sync');
  return res.data;
}

// ---------- 8. Recent activity ---------------------------------------------

export type ActivityKind =
  | 'product_updated'
  | 'product_created'
  | 'service_updated'
  | 'service_created'
  | 'login_succeeded'
  | 'business_info_updated'
  | 'broadcast_sent'
  | 'bot_deployed'
  | 'bot_undeployed'
  | 'faq_updated'
  | 'faq_created'
  | 'policy_updated';

export interface ActivityEvent {
  id: string;
  kind: string;
  description: string;
  at: string;
}

export async function getRecentActivity(): Promise<ActivityEvent[]> {
  const res = await api.get<{ data: { events: ActivityEvent[] } }>(
    '/api/v1/dashboard/widgets/recent-activity',
  );
  return res.data.events;
}

// ---------- 9. Sales & revenue · 7d ----------------------------------------

export interface SalesData {
  currency: string;
  orders7d: number;
  ordersToday: number;
  revenue7dMinor: number;
  paid7d: number;
  aovMinor: number;
}

export async function getSales(): Promise<SalesData> {
  const res = await api.get<{ data: SalesData }>('/api/v1/dashboard/widgets/sales');
  return res.data;
}

// ---------- 10. Conversion funnel · 7d -------------------------------------

export interface ConversionFunnelData {
  conversations: number;
  cartsStarted: number;
  ordersPlaced: number;
  ordersPaid: number;
}

export async function getConversionFunnel(): Promise<ConversionFunnelData> {
  const res = await api.get<{ data: ConversionFunnelData }>(
    '/api/v1/dashboard/widgets/conversion-funnel',
  );
  return res.data;
}

// ---------- 11. Channel mix · 7d -------------------------------------------

export interface ChannelMixData {
  channels: { channel: string; conversations: number }[];
  voiceCalls: number;
}

export async function getChannelMix(): Promise<ChannelMixData> {
  const res = await api.get<{ data: ChannelMixData }>('/api/v1/dashboard/widgets/channel-mix');
  return res.data;
}

// ---------- 12. Audience & compliance --------------------------------------

export interface AudienceData {
  total: number;
  newThisWeek: number;
  optedOut: number;
  blocked: number;
}

export async function getAudience(): Promise<AudienceData> {
  const res = await api.get<{ data: AudienceData }>('/api/v1/dashboard/widgets/audience');
  return res.data;
}

// ---------- 13. Reply quality · 7d -----------------------------------------

export interface ReplyQualityData {
  total: number;
  flagged: number;
}

export async function getReplyQuality(): Promise<ReplyQualityData> {
  const res = await api.get<{ data: ReplyQualityData }>(
    '/api/v1/dashboard/widgets/reply-quality',
  );
  return res.data;
}

// ---------- 14b. Orders by channel · 7d ------------------------------------

export interface OrdersByChannelData {
  currency: string;
  channels: { channel: string; orders: number; revenueMinor: number }[];
}

export async function getOrdersByChannel(): Promise<OrdersByChannelData> {
  const res = await api.get<{ data: OrdersByChannelData }>(
    '/api/v1/dashboard/widgets/orders-by-channel',
  );
  return res.data;
}

// ---------- 14. Voice calls · 7d -------------------------------------------

export interface VoiceData {
  total: number;
  completed: number;
  handoff: number;
  dropped: number;
  inProgress: number;
}

export async function getVoice(): Promise<VoiceData> {
  const res = await api.get<{ data: VoiceData }>('/api/v1/dashboard/widgets/voice');
  return res.data;
}

// ---------- Overview hero (sandbox-style tenant dashboard) ------------------

export interface OverviewData {
  conversations7d: number;
  conversationsDeltaPct: number | null;
  medianReplySeconds: number | null;
  orders7d: number;
  ordersToday: number;
  aiHandledPercent: number;
  humanPercent: number;
  byDay: { label: string; count: number }[];
}

export async function getOverview(): Promise<OverviewData> {
  const res = await api.get<{ data: OverviewData }>('/api/v1/dashboard/widgets/overview');
  return res.data;
}

export interface BookingWeekItem {
  time: string;
  title: string;
  subtitle: string | null;
  status: string;
}
export interface BookingWeekDay {
  label: string;
  dayNum: number;
  isToday: boolean;
  items: BookingWeekItem[];
}
export interface BookingsWeekData {
  total: number;
  days: BookingWeekDay[];
}

export async function getBookingsWeek(): Promise<BookingsWeekData> {
  const res = await api.get<{ data: BookingsWeekData }>('/api/v1/dashboard/widgets/bookings-week');
  return res.data;
}
