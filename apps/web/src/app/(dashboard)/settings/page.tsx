'use client';

import type { MessengerChannelDto, ShopifyConnectionDto, WhatsAppChannelDto } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, CalendarClock, CreditCard, Download, GraduationCap, Key, MessageCircle, Phone, ShoppingBag, Trash2, User, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

// 'connected' / 'off' render a live badge; undefined (still loading, query
// failed, or simply not applicable) renders nothing — a wrong badge is worse
// than none.
type LinkStatus = 'connected' | 'off' | undefined;

function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
  status,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status?: LinkStatus;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-brand-400 hover:bg-surface-muted/40"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-500">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            {title}
            {status === 'connected' ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                <span className="size-1.5 rounded-full bg-success" /> Connected
              </span>
            ) : status === 'off' ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-foreground-subtle">
                <span className="size-1.5 rounded-full bg-foreground-subtle/50" /> Not connected
              </span>
            ) : null}
            <ArrowRight className="size-3.5 translate-x-0 text-foreground-subtle opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
          </p>
          <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>
        </div>
      </div>
    </Link>
  );
}

export default function SettingsPage() {
  const { session } = useSession();
  const router = useRouter();
  const organization = session?.organization;
  const user = session?.user;
  const isOrgAdmin = organization?.role === 'admin';
  const disabledFeatures = organization?.disabledFeatures ?? [];
  // Three-valued on purpose. `disabledFeatures` defaults to [] while the session is
  // still loading, which makes every `!includes(...)` check briefly TRUE — so gated
  // cards flash visible before disappearing. `undefined` means "not known yet".
  const featuresKnown = !!organization;
  const salesScanOn = featuresKnown ? !disabledFeatures.includes('sales_scan') : undefined;
  const phoneOn = !disabledFeatures.includes('phone');
  const shopifyOn = !disabledFeatures.includes('shopify');
  const bookingsOn = !disabledFeatures.includes('bookings');
  // Messenger + Instagram share the /settings/messenger page. Show it while
  // EITHER channel is enabled; hide the whole section only when BOTH are off.
  const messagingOn =
    !disabledFeatures.includes('messenger') || !disabledFeatures.includes('instagram');
  const [deleting, setDeleting] = useState(false);

  // ---- live integration statuses -----------------------------------------
  // Each is a cheap viewer-safe GET. Every query fails SILENT (retry: false,
  // badge stays absent) — this page must never toast because one integration's
  // status endpoint had a bad day. Feature-gated endpoints are only queried
  // once the session confirms the feature is on, so a gated 403 never fires.
  const waStatusQ = useQuery({
    queryKey: ['settings-status-whatsapp'],
    queryFn: () => api.get<{ data: WhatsAppChannelDto[] }>('/api/v1/whatsapp/numbers'),
    enabled: featuresKnown,
    retry: false,
    staleTime: 60_000,
  });
  const messengerStatusQ = useQuery({
    queryKey: ['settings-status-messenger'],
    queryFn: () => api.get<{ data: MessengerChannelDto }>('/api/v1/messenger'),
    enabled: featuresKnown && messagingOn,
    retry: false,
    staleTime: 60_000,
  });
  const shopifyStatusQ = useQuery({
    queryKey: ['settings-status-shopify'],
    queryFn: () => api.get<{ data: ShopifyConnectionDto }>('/api/v1/shopify'),
    enabled: featuresKnown && shopifyOn,
    retry: false,
    staleTime: 60_000,
  });
  const gcalStatusQ = useQuery({
    queryKey: ['settings-status-gcal'],
    queryFn: () =>
      api.get<{ data: { connected: boolean; email: string | null } }>(
        '/api/v1/google-calendar/status',
      ),
    enabled: featuresKnown && bookingsOn,
    retry: false,
    staleTime: 60_000,
  });

  const toStatus = (known: boolean, connected: boolean): 'connected' | 'off' | undefined =>
    known ? (connected ? 'connected' : 'off') : undefined;
  const waNumbers = waStatusQ.data?.data;
  const waStatus = toStatus(
    !!waNumbers,
    (waNumbers ?? []).some((n) => n.isActive && (n.phoneNumberId || n.displayPhoneNumber)),
  );
  const messengerCfg = messengerStatusQ.data?.data;
  const messengerStatus = toStatus(
    !!messengerCfg,
    !!messengerCfg && (messengerCfg.isActive || (!!messengerCfg.pageId && messengerCfg.hasPageAccessToken)),
  );
  const shopifyStatus = toStatus(!!shopifyStatusQ.data, shopifyStatusQ.data?.data.connected ?? false);
  const gcalStatus = toStatus(!!gcalStatusQ.data, gcalStatusQ.data?.data.connected ?? false);

  async function deleteOrganization() {
    const confirmed = await confirmDialog({
      title: `Are you sure you want to delete ${organization?.name ?? 'this organization'}?`,
      body:
        'This is irreversible. Every product, service, FAQ, audit entry, member, API key, webhook endpoint, connector, and WhatsApp message will be deleted. ' +
        'Other organizations are unaffected. You will be signed out.',
      confirmLabel: 'Delete organization',
      destructive: true,
      // Force the admin to type "delete" before the button enables.
      requireText: 'delete',
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await api.delete('/api/v1/organization');
      toast.success('Organization deleted.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Delete failed.');
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace and account preferences."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-4" /> Organization
            </CardTitle>
            <CardDescription>
              {organization ? (
                <>
                  Currently viewing{' '}
                  <span className="font-medium text-foreground">
                    {organization.name}
                  </span>{' '}
                  · <span className="font-mono">{organization.slug}</span>
                </>
              ) : (
                'Your workspace.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/members"
              icon={Users}
              title="Members"
              description="Invite teammates, assign roles, deactivate users."
            />
            <SettingsLink
              href="/settings/billing"
              icon={CreditCard}
              title="Plan"
              description="Your current plan and usage caps."
            />
            {/* Branding is Phase 2 — hidden until logo/accent/footer
                are wired into the actual portal layout. The /settings/branding
                route still loads via direct URL, but no UI links to it. */}
            <SettingsLink
              href="/settings/data-export"
              icon={Download}
              title="Data export"
              description="Download all your products, conversations, and bot config (GDPR)."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="size-4" /> Integrations
            </CardTitle>
            <CardDescription>
              Connect WhatsApp, Messenger, Instagram and phone channels to your chatbot.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/whatsapp"
              icon={MessageCircle}
              title="WhatsApp"
              status={waStatus}
              description="Connect your Meta WhatsApp Business number + manage templates."
            />
            {messagingOn && (
              <SettingsLink
                href="/settings/messenger"
                icon={MessageCircle}
                title="Messenger & Instagram"
                status={messengerStatus}
                description="Let the AI bot answer your Facebook Page and Instagram DMs, not just WhatsApp."
              />
            )}
            {shopifyOn ? (
              <SettingsLink
                href="/settings/shopify"
                icon={ShoppingBag}
                title="Shopify"
                status={shopifyStatus}
                description="Connect your Shopify store, scrape products, customers & policies, then review and import."
              />
            ) : null}
            {phoneOn ? (
              <SettingsLink
                href="/phone-integrations"
                icon={Phone}
                title="Phone integration"
                description="Connect phone numbers to your AI voicebot (Aseer-time phone bridge)."
              />
            ) : null}
            {bookingsOn ? (
              <SettingsLink
                href="/settings/google-calendar"
                icon={CalendarClock}
                title="Google Calendar"
                status={gcalStatus}
                description="Sync your bookings to Google Calendar — every appointment appears automatically."
              />
            ) : null}
            {/*
              Hidden when off, like every other feature. This card used to stay VISIBLE
              with a "contact admin to upgrade" prompt — the one deviation in the app —
              and that was reversed on 2026-08-05 by owner decision. Do not reintroduce it.

              The three-valued check is still load-bearing: `disabledFeatures` is [] while
              the session loads, so a plain `!includes(...)` would flash this card visible
              to tenants who do not have the feature.
            */}
            {salesScanOn === true ? (
              <SettingsLink
                href="/settings/sales-scan"
                icon={GraduationCap}
                title="Teach the bot with your own data"
                description="Connect the sales number you already use, and we'll learn how your team talks and what customers keep asking."
              />
            ) : null}
          </CardContent>
        </Card>

        {/* Account + the danger zone (delete org) live together in one box. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-4" /> Your account
            </CardTitle>
            <CardDescription>
              {user
                ? `Signed in as ${user.email}.`
                : 'Your personal account.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <SettingsLink
              href="/settings/profile"
              icon={User}
              title="Profile & password"
              description="Update your name, change your password."
            />

            {isOrgAdmin ? (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3 dark:border-red-400/30 dark:bg-red-400/10">
                <div>
                  <p className="text-sm font-semibold text-red-700">Delete organization</p>
                  <p className="mt-0.5 text-xs text-foreground-muted">
                    Hard-delete this organisation and every entity inside it. Other organisations are
                    unaffected. Refused if a member of this org is the last admin somewhere else.
                  </p>
                </div>
                <Button variant="danger" loading={deleting} onClick={deleteOrganization}>
                  <Trash2 className="size-4" /> Delete organization
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
