// Single source of truth for dashboard widgets. The registry holds
// id → component + metadata (title, default-on, layout slot). The
// dashboard page reads this list in render-order and skips any widget
// the operator has hidden via the layout state.
//
// Adding a new widget is two edits:
//   1) build the component under ./widgets/your-widget.tsx
//   2) append an entry below
// Everything else (the ADD/KEEP toggles, the Add-widget dialog,
// localStorage persistence) picks it up for free.

import {
  Activity,
  Bot,
  Filter,
  Gauge,
  Inbox,
  LayoutGrid,
  ListChecks,
  PhoneCall,
  Plug,
  Radio,
  Send,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';

import { AiBudgetWidget } from './widgets/ai-budget';
import { AudienceComplianceWidget } from './widgets/audience-compliance';
import { BotPerformanceWidget } from './widgets/bot-performance';
import { ChannelMixWidget } from './widgets/channel-mix';
import { ConnectionsSyncWidget } from './widgets/connections-sync';
import { ConversionFunnelWidget } from './widgets/conversion-funnel';
import { InboxSnapshotWidget } from './widgets/inbox-snapshot';
import { KpiStripWidget } from './widgets/kpi-strip';
import { OnboardingChecklistWidget } from './widgets/onboarding-checklist';
import { OrdersByChannelWidget } from './widgets/orders-by-channel';
import { OutreachCampaignsWidget } from './widgets/outreach-campaigns';
import { RecentActivityWidget } from './widgets/recent-activity';
import { ReplyQualityWidget } from './widgets/reply-quality';
import { SalesRevenueWidget } from './widgets/sales-revenue';
import { UsageLimitsWidget } from './widgets/usage-limits';
import { VoiceCallsWidget } from './widgets/voice-calls';
import { WalletBalanceWidget } from './widgets/wallet-balance';

export type WidgetId =
  | 'kpi-strip'
  | 'onboarding'
  | 'inbox-snapshot'
  | 'bot-performance'
  | 'sales-revenue'
  | 'conversion-funnel'
  | 'outreach'
  | 'ai-budget'
  | 'connections'
  | 'recent-activity'
  | 'channel-mix'
  | 'audience'
  | 'reply-quality'
  | 'voice-calls'
  | 'orders-by-channel'
  | 'usage-limits'
  | 'wallet-balance';

/**
 * Where the widget lives on the page. The dashboard places `full`
 * widgets at full width and `half` widgets inside a 2-col grid.
 * `kpi` is a special slot for the top stat strip (4-col responsive).
 */
export type WidgetSlot = 'kpi' | 'full' | 'half';

export interface WidgetDef {
  id: WidgetId;
  /** Human label shown in the Add-widget dialog. */
  title: string;
  /** Short blurb shown under the title in the Add-widget dialog. */
  description: string;
  icon: LucideIcon;
  slot: WidgetSlot;
  /** True = visible by default for a fresh user / cleared layout. */
  defaultOn: boolean;
  /**
   * Org-feature key this widget depends on. When the tenant has that feature
   * disabled, the dashboard hides the widget entirely (and it won't appear in
   * the Add-widget dialog). Omit for feature-neutral widgets.
   */
  feature?: string;
  /**
   * Internal/ops widget shown ONLY to ALIGNED admins — hidden from regular
   * tenants and their Add-widget dialog (e.g. connector-sync + webhook health
   * that customers shouldn't see).
   */
  adminOnly?: boolean;
  Component: ComponentType;
}

// Order matters: the dashboard renders widgets in this array's order
// (filtered by the current layout). KPI strip first, then onboarding
// banner, then the 2-col grid of half-width cards.
export const WIDGETS: WidgetDef[] = [
  {
    id: 'kpi-strip',
    title: 'Key counts',
    description: 'Products, services, FAQs, contacts — at a glance.',
    icon: LayoutGrid,
    slot: 'kpi',
    defaultOn: true,
    Component: KpiStripWidget,
  },
  {
    id: 'onboarding',
    title: 'Getting-started checklist',
    description: 'Connect WhatsApp → add catalog → train bot → go live.',
    icon: ListChecks,
    slot: 'full',
    defaultOn: true,
    Component: OnboardingChecklistWidget,
  },
  {
    id: 'inbox-snapshot',
    title: 'Inbox snapshot',
    description: 'Open / unassigned / awaiting reply + first-response time.',
    icon: Inbox,
    slot: 'half',
    defaultOn: true,
    feature: 'inbox',
    Component: InboxSnapshotWidget,
  },
  {
    id: 'bot-performance',
    title: 'Bot performance · today',
    description: 'Auto-resolved %, messages handled, escalations, top FAQ.',
    icon: Bot,
    slot: 'half',
    defaultOn: true,
    feature: 'ai',
    Component: BotPerformanceWidget,
  },
  {
    id: 'sales-revenue',
    title: 'Sales & revenue · 7d',
    description: 'Orders, revenue, avg order value + paid count — the bottom line.',
    icon: ShoppingBag,
    slot: 'half',
    defaultOn: true,
    feature: 'orders',
    Component: SalesRevenueWidget,
  },
  {
    id: 'conversion-funnel',
    title: 'Conversion funnel · 7d',
    description: 'Conversations → carts → orders → paid, with drop-off at each step.',
    icon: Filter,
    slot: 'half',
    defaultOn: true,
    feature: 'orders',
    Component: ConversionFunnelWidget,
  },
  {
    id: 'outreach',
    title: 'Outreach & campaigns',
    description: 'Active campaign status + sent / delivered / read funnel.',
    icon: Send,
    slot: 'half',
    defaultOn: true,
    feature: 'broadcasts',
    Component: OutreachCampaignsWidget,
  },
  {
    id: 'ai-budget',
    title: 'AI messages · this month',
    description: 'How many AI messages you have left in your monthly allowance.',
    icon: Sparkles,
    slot: 'half',
    defaultOn: true,
    feature: 'ai',
    Component: AiBudgetWidget,
  },
  {
    id: 'wallet-balance',
    title: 'WhatsApp balance',
    description: 'Prepaid balance and messages remaining.',
    icon: Wallet,
    slot: 'half',
    // Off by default — the always-on wallet card pinned to the top of the
    // dashboard shows this already. Still available to add as a grid widget.
    defaultOn: false,
    Component: WalletBalanceWidget,
  },
  {
    id: 'usage-limits',
    title: 'Usage & limits',
    description: 'Every limit you can hit — AI messages, plan messages, broadcasts, imports, products. Warns before anything stops.',
    icon: Gauge,
    slot: 'half',
    defaultOn: true,
    Component: UsageLimitsWidget,
  },
  {
    id: 'connections',
    title: 'Connections & sync',
    description: 'Last sync, template approvals, webhook health.',
    icon: Plug,
    slot: 'half',
    defaultOn: true,
    // Internal/ops view — hidden from tenants, shown only to ALIGNED admins.
    adminOnly: true,
    Component: ConnectionsSyncWidget,
  },
  {
    id: 'recent-activity',
    title: 'Recent activity',
    description: 'The latest audit-log events with relative timestamps.',
    icon: Activity,
    slot: 'half',
    defaultOn: true,
    Component: RecentActivityWidget,
  },
  // --- Available-to-add widgets (off by default to keep the default
  //     board focused; operators add them from the "Add widgets" dialog). ---
  {
    id: 'channel-mix',
    title: 'Channel mix · 7d',
    description: 'Where conversations come from — WhatsApp / Messenger / Instagram / voice.',
    icon: Radio,
    slot: 'half',
    defaultOn: false,
    Component: ChannelMixWidget,
  },
  {
    id: 'audience',
    title: 'Audience & compliance',
    description: 'Contact-list size + growth, opt-out rate, blocked contacts.',
    icon: Users,
    slot: 'half',
    defaultOn: false,
    feature: 'contacts',
    Component: AudienceComplianceWidget,
  },
  {
    id: 'reply-quality',
    title: 'Reply quality · 7d',
    description: 'Share of grounded bot replies + count flagged for unsupported claims.',
    icon: ShieldCheck,
    slot: 'half',
    defaultOn: false,
    feature: 'ai',
    Component: ReplyQualityWidget,
  },
  {
    id: 'voice-calls',
    title: 'Voice calls · 7d',
    description: 'Phone-voicebot volume + completed / handoff / dropped outcomes.',
    icon: PhoneCall,
    slot: 'half',
    defaultOn: false,
    feature: 'phone',
    Component: VoiceCallsWidget,
  },
  {
    id: 'orders-by-channel',
    title: 'Orders by channel · 7d',
    description: 'Orders + revenue broken out by WhatsApp / Messenger / Instagram / voice.',
    icon: ShoppingBag,
    slot: 'half',
    defaultOn: false,
    feature: 'orders',
    Component: OrdersByChannelWidget,
  },
];

export const WIDGETS_BY_ID: Record<WidgetId, WidgetDef> = WIDGETS.reduce(
  (acc, w) => ((acc[w.id] = w), acc),
  {} as Record<WidgetId, WidgetDef>,
);

export const DEFAULT_LAYOUT: WidgetId[] = WIDGETS.filter((w) => w.defaultOn).map((w) => w.id);
