'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

// "The system reports its own state." A compact, always-visible strip so the
// operator can see open conversations and anything escalated without hunting.
// Reuses the sidebar's inbox-counts query (same key → shared cache, no extra
// network). Hidden on small screens to keep the mobile top bar clean.
export function StatusStrip() {
  const { session } = useSession();

  const counts = useQuery({
    enabled: !!session,
    queryKey: ['sidebar-inbox-counts'], // shares the sidebar's cache
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number } }>('/api/v1/inbox/counts'),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  if (!session) return null;
  const open = counts.data?.data.open ?? 0;
  const escalated = counts.data?.data.escalated ?? 0;

  return (
    <div className="hidden items-center gap-1 text-xs text-foreground-muted md:flex">
      {open > 0 ? (
        <Link
          href="/inbox"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-surface-muted"
          title="Open conversations"
        >
          <span className="size-1.5 rounded-full bg-success" />
          <span className="font-mono tabular-nums">{open}</span>
          <span className="text-foreground-subtle">chats open</span>
        </Link>
      ) : null}

      {escalated > 0 ? (
        <Link
          href="/inbox?status=escalated"
          className="flex items-center gap-1.5 rounded-md bg-coral-50 px-2 py-1 font-medium text-coral-700 transition-colors hover:bg-coral-100"
          title="Conversations escalated to a human"
        >
          <span className="size-1.5 rounded-full bg-coral-500" />
          <span className="font-mono tabular-nums">{escalated}</span>
          <span>escalated</span>
        </Link>
      ) : null}
    </div>
  );
}
