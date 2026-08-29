'use client';

import type { OrgRole } from '@platform/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  api,
  ApiError,
  clearAccessToken,
  getAccessToken,
  setAccessToken,
  SESSION_EXPIRED_EVENT,
  tryRefresh,
} from './api';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  isSuperAdmin: boolean;
}

export interface SessionOrganization {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  // super-admin per-tenant access control (disabled feature keys). Absent on
  // availableOrganizations entries (only the active org carries it).
  disabledFeatures?: string[];
  // F1 — this member's page whitelist (null/absent = full access for role).
  pageAccess?: string[] | null;
}

export interface SessionState {
  user: SessionUser;
  organization: SessionOrganization;
  availableOrganizations: SessionOrganization[];
}

interface SessionContextValue {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  session: SessionState | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  switchOrg: (organizationId: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<SessionContextValue['status']>('loading');

  // Bootstrap the session from the refresh cookie. CRITICAL: goes through
  // api.ts's exported `tryRefresh` (the SAME single-flight lock that
  // apiFetch's 401-retry uses) so we never end up with TWO concurrent
  // POST /auth/refresh calls from the same browser. Two concurrent
  // refreshes trip the server's reuse-detection (the second arrives
  // with the just-rotated previous-token-hash), the session family is
  // revoked, and the user lands on /login mid-session. That was the
  // 'hard-refresh logs me out' bug surfaced on 2026-06-01.
  const refresh = useCallback(async () => {
    try {
      await tryRefresh();
      if (!getAccessToken()) {
        clearAccessToken();
        setSession(null);
        setStatus('unauthenticated');
        return;
      }
      const data = await api.get<SessionState>('/api/v1/auth/session');
      setSession(data);
      setStatus('authenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAccessToken();
        setSession(null);
        setStatus('unauthenticated');
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for the SESSION_EXPIRED_EVENT emitted by api.ts when
  // /auth/refresh returns 401 from inside a non-session-manager code
  // path (any polling useQuery, the SSE helper, etc). Cancel + clear
  // all React Query state at the source so 401 storms can't outlast
  // the redirect, then flip status — the dashboard layout's existing
  // useEffect picks up 'unauthenticated' and replaces to /login.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      // Drain everything in flight or scheduled. Without this, polling
      // queries (crawl status, inbox counts, notifications) keep firing
      // every refetchInterval, each one re-401s and fights the redirect.
      void queryClient.cancelQueries();
      queryClient.clear();
      clearAccessToken();
      setSession(null);
      setStatus('unauthenticated');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      void queryClient.cancelQueries();
      queryClient.clear();
      clearAccessToken();
      setSession(null);
      setStatus('unauthenticated');
      router.push('/login');
    }
  }, [router, queryClient]);

  const switchOrg = useCallback(
    async (organizationId: string) => {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/switch-org',
        { organizationId },
      );
      setAccessToken(res.accessToken, res.expiresAt);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, session, refresh, signOut, switchOrg }),
    [status, session, refresh, signOut, switchOrg],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
