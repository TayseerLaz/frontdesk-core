'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftToLine, Eye } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/session';

/**
 * Global banner shown on EVERY page while an super-admin is "controlling" a
 * tenant (impersonation). It makes the impersonation state obvious and gives a
 * one-click way back to the admin's own account, so the admin is never stranded
 * inside a tenant workspace. Renders nothing in the normal (non-control) case.
 */
export function ControllingBanner() {
  const { session, switchOrg } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // "Controlling" = an platform admin whose ACTIVE org isn't one of their own
  // memberships (impersonation mints a no-membership session for the tenant).
  const adminOrgIds = new Set((session?.availableOrganizations ?? []).map((o) => o.id));
  const isControlling =
    !!session?.user.isSuperAdmin &&
    !!session?.organization &&
    !adminOrgIds.has(session.organization.id);
  const homeOrgId = session?.availableOrganizations?.[0]?.id ?? null;

  if (!isControlling) return null;

  async function backToAdmin() {
    if (!homeOrgId) return;
    setBusy(true);
    try {
      await switchOrg(homeOrgId);
      qc.clear();
      toast.success('Back to your admin account.');
      router.push('/hq');
    } catch {
      toast.error('Could not switch back to your admin account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <span className="flex items-center gap-2">
        <Eye className="size-4 shrink-0" />
        You’re controlling <strong>{session?.organization?.name}</strong> as a super-admin.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void backToAdmin()}
        disabled={busy || !homeOrgId}
        title="Stop controlling this tenant and return to your admin account"
      >
        <ArrowLeftToLine className="size-4" /> {busy ? 'Switching…' : 'Back to admin'}
      </Button>
    </div>
  );
}
