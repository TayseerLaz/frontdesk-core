'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

import { DEFAULT_LAYOUT, WIDGETS_BY_ID, type WidgetId } from './widget-registry';

// Server-persisted layout state with localStorage as a first-paint cache.
//
// Why both:
//   - The /me/dashboard-layout endpoint is the source of truth. It
//     follows the operator across devices, browsers, incognito sessions,
//     and any "clear my cookies" event.
//   - localStorage is read synchronously on mount so the dashboard
//     doesn't paint with the default layout for ~200ms while the server
//     query is in flight. The cached value is replaced the moment the
//     server response lands.
//
// PUT requests are debounced (400ms) — the operator clicking
// add/remove/add quickly only triggers one round trip.

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = 'aligned-dashboard-layout';
const ONBOARDING_DISMISSED_PREFIX = 'aligned-dashboard-onboarding-dismissed';
const PUT_DEBOUNCE_MS = 400;
const LAYOUT_QUERY_KEY = ['dashboard-layout'] as const;

interface StoredLayout {
  v: number;
  widgets: WidgetId[];
}

function storageKey(userId: string | null): string {
  return `${STORAGE_PREFIX}:${userId ?? 'anonymous'}`;
}
function onboardingKey(userId: string | null): string {
  return `${ONBOARDING_DISMISSED_PREFIX}:${userId ?? 'anonymous'}`;
}

function readCache(userId: string | null): WidgetId[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLayout;
    if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.widgets)) return null;
    return parsed.widgets.filter((id): id is WidgetId => id in WIDGETS_BY_ID);
  } catch {
    return null;
  }
}

function writeCache(userId: string | null, widgets: WidgetId[]): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredLayout = { v: STORAGE_VERSION, widgets };
    window.localStorage.setItem(storageKey(userId), JSON.stringify(payload));
  } catch {
    /* quota / serialization issues — silent fallback */
  }
}

function sortByRegistry(ids: WidgetId[]): WidgetId[] {
  const order = Object.keys(WIDGETS_BY_ID) as WidgetId[];
  return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export interface DashboardLayoutApi {
  visible: WidgetId[];
  hidden: WidgetId[];
  has: (id: WidgetId) => boolean;
  add: (id: WidgetId) => void;
  remove: (id: WidgetId) => void;
  reset: () => void;
  onboardingDismissed: boolean;
  dismissOnboarding: () => void;
}

interface LayoutResponse {
  data: { widgets: string[] } | null;
}

export function useDashboardLayout(): DashboardLayoutApi {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const qc = useQueryClient();

  // Local optimistic copy — what we render. Seeded from localStorage on
  // first mount so the initial paint matches the operator's saved set,
  // then replaced by the server response when it arrives.
  const [visible, setVisible] = useState<WidgetId[]>(DEFAULT_LAYOUT);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // Hydrate from localStorage cache + the dismissal flag once we know
  // who the user is.
  useEffect(() => {
    const cached = readCache(userId);
    if (cached && cached.length > 0) setVisible(cached);
    if (typeof window !== 'undefined') {
      setOnboardingDismissed(window.localStorage.getItem(onboardingKey(userId)) === '1');
    }
  }, [userId]);

  // Server source of truth. Only fetches when the user is logged in.
  const layoutQuery = useQuery({
    queryKey: LAYOUT_QUERY_KEY,
    queryFn: () => api.get<LayoutResponse>('/api/v1/me/dashboard-layout'),
    enabled: !!session,
    staleTime: 60_000,
  });

  // When the server response lands, reconcile: any unknown ids are
  // dropped; the result becomes our render set + the localStorage cache.
  useEffect(() => {
    const stored = layoutQuery.data?.data;
    if (!layoutQuery.isSuccess) return;
    if (stored == null) {
      // Server returned null — first visit, no saved layout. Persist
      // the defaults so the next device sees them too.
      setVisible(DEFAULT_LAYOUT);
      writeCache(userId, DEFAULT_LAYOUT);
      return;
    }
    const cleaned = stored.widgets.filter((id): id is WidgetId => id in WIDGETS_BY_ID);
    setVisible(cleaned);
    writeCache(userId, cleaned);
  }, [layoutQuery.isSuccess, layoutQuery.data, userId]);

  // Debounced PUT mutation. The mutation invalidates nothing — local
  // state is already the truth; we only persist it.
  const putMutation = useMutation({
    mutationFn: (widgets: WidgetId[]) =>
      api.put<LayoutResponse>('/api/v1/me/dashboard-layout', { widgets }),
    onError: (err) => {
      // Don't roll back the local state — the operator's intent is
      // clearer than the network failure. We'll retry on the next
      // change, and the localStorage cache still bridges the gap.
      // eslint-disable-next-line no-console
      console.warn(
        '[dashboard-layout] PUT failed; keeping local + cached state',
        err instanceof ApiError ? err.payload.message : err,
      );
    },
  });

  const putTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePut = useCallback(
    (next: WidgetId[]) => {
      if (!session) return;
      if (putTimer.current) clearTimeout(putTimer.current);
      putTimer.current = setTimeout(() => {
        putMutation.mutate(next);
        // Update the cached query so refetch-on-focus doesn't blink
        // back to the previous value.
        qc.setQueryData(LAYOUT_QUERY_KEY, { data: { widgets: next } });
      }, PUT_DEBOUNCE_MS);
    },
    [putMutation, qc, session],
  );

  const persist = useCallback(
    (next: WidgetId[]) => {
      setVisible(next);
      writeCache(userId, next);
      schedulePut(next);
    },
    [userId, schedulePut],
  );

  const has = useCallback((id: WidgetId) => visible.includes(id), [visible]);
  const add = useCallback(
    (id: WidgetId) => {
      if (visible.includes(id)) return;
      persist(sortByRegistry([...visible, id]));
    },
    [visible, persist],
  );
  const remove = useCallback(
    (id: WidgetId) => {
      if (!visible.includes(id)) return;
      persist(visible.filter((x) => x !== id));
    },
    [visible, persist],
  );
  const reset = useCallback(() => persist(DEFAULT_LAYOUT), [persist]);

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(onboardingKey(userId), '1');
      } catch {
        /* ignore */
      }
    }
  }, [userId]);

  const hidden = useMemo(() => {
    const all = Object.keys(WIDGETS_BY_ID) as WidgetId[];
    return all.filter((id) => !visible.includes(id));
  }, [visible]);

  return { visible, hidden, has, add, remove, reset, onboardingDismissed, dismissOnboarding };
}
