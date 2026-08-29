'use client';

import type { NotificationDto } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  CheckCheck,
  CheckCircle2,
  Info,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatRelative } from '@/lib/format';
import { connectSse } from '@/lib/sse';
import { cn } from '@/lib/utils';

// ---- assignment chime (F6) -------------------------------------------------
// WebAudio two-tone ping — no bundled asset, no <audio> autoplay problem. The
// AudioContext is created + resumed on the user's FIRST gesture (browsers
// refuse audio before one); if it never unlocks, the chime silently no-ops.
const SOUND_PREF_KEY = 'platform:notify-sound';

function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

let audioCtx: AudioContext | null = null;
function armAudioOnFirstGesture() {
  const unlock = () => {
    try {
      audioCtx ??= new AudioContext();
      void audioCtx.resume();
    } catch {
      /* no WebAudio — stay silent */
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  return () => window.removeEventListener('pointerdown', unlock);
}

function playChime() {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.12],
    ] as const) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.4);
    }
  } catch {
    /* never let the chime break the shell */
  }
}

const SEVERITY_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
} as const;

const SEVERITY_TEXT = {
  info: 'text-foreground-muted',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  error: 'text-red-600',
} as const;

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { session } = useSession();
  // Assignment chime rides the opt-in inbox_teamwork feature (owner
  // directive 2026-08-29). Three-valued: no SSE until the session loads.
  const teamworkOn =
    !!session && !(session.organization?.disabledFeatures ?? []).includes('inbox_teamwork');
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(soundEnabled()), []);
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<{ data: NotificationDto[]; unreadCount: number }>('/api/v1/notifications?limit=20'),
    refetchInterval: 30_000,
  });

  // Live "assigned to you" pings (F6): the inbox SSE stream sends targeted
  // `notify` frames only to this user's connections. Chime + toast + (when the
  // tab is hidden and permission was granted) a desktop notification.
  const routerRef = useRef(router);
  routerRef.current = router;
  useEffect(() => {
    if (!teamworkOn) return;
    const disarmAudio = armAudioOnFirstGesture();
    const dispose = connectSse('/api/v1/inbox/sse', {
      onNotify: (n) => {
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        if (soundEnabled()) playChime();
        toast(n.title, {
          description: n.body ?? undefined,
          action: n.threadId
            ? { label: 'Open', onClick: () => routerRef.current.push(`/inbox?thread=${n.threadId}`) }
            : undefined,
        });
        try {
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const desktop = new Notification(n.title, { body: n.body ?? undefined });
            desktop.onclick = () => {
              window.focus();
              if (n.threadId) routerRef.current.push(`/inbox?thread=${n.threadId}`);
            };
          }
        } catch {
          /* desktop notifications are best-effort */
        }
      },
    });
    return () => {
      dispose();
      disarmAudio();
    };
  }, [queryClient, teamworkOn]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try {
      localStorage.setItem(SOUND_PREF_KEY, next ? 'on' : 'off');
    } catch {
      /* private mode — preference just won't persist */
    }
    // Turning sound on is a user gesture — also the moment to ask for desktop
    // notification permission (never on page load).
    if (next && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/api/v1/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.data ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell className="size-4" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[95vw]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          <span className="flex items-center gap-3">
            {teamworkOn ? (
            <button
              type="button"
              onClick={toggleSound}
              className="inline-flex items-center gap-1 text-xs text-foreground-subtle hover:text-foreground"
              title={soundOn ? 'Mute the assignment sound' : 'Play a sound when a chat is assigned to me'}
            >
              {soundOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              {soundOn ? 'Sound on' : 'Muted'}
            </button>
            ) : null}
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
              >
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            ) : null}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-foreground-muted">
            You're all caught up.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((n) => {
              const Icon = SEVERITY_ICON[n.severity];
              const Body = (
                <div className={cn('flex gap-3 px-3 py-2.5', !n.isRead && 'bg-brand-50/40')}>
                  <Icon className={cn('mt-0.5 size-4 shrink-0', SEVERITY_TEXT[n.severity])} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{n.title}</p>
                    {n.body ? (
                      <p className="mt-0.5 text-xs text-foreground-muted">{n.body}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-foreground-subtle">
                      {formatRelative(n.createdAt)}
                    </p>
                  </div>
                </div>
              );
              return (
                <li
                  key={n.id}
                  className="border-b border-border last:border-0"
                  onClick={() => !n.isRead && markRead.mutate(n.id)}
                >
                  {n.link ? (
                    <Link href={n.link} className="block hover:bg-surface-muted/50">
                      {Body}
                    </Link>
                  ) : (
                    <div className="hover:bg-surface-muted/50">{Body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
