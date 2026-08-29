'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

type State = 'idle' | 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-full" />
        </div>
      }
    >
      <VerifyEmailInner />
    </Suspense>
  );
}

function VerifyEmailInner() {
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState('error');
      setError('This verification link is missing a token.');
      return;
    }
    let cancelled = false;
    (async () => {
      setState('loading');
      try {
        await api.post('/api/v1/auth/verify-email', { token }, { anonymous: true });
        if (!cancelled) setState('success');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.payload.message : 'Verification failed.');
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="space-y-6">
      {state === 'loading' || state === 'idle' ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Verifying your email…</h1>
          <p className="text-sm text-foreground-muted">This will just take a moment.</p>
        </>
      ) : null}

      {state === 'success' ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Email verified</h1>
          <p className="text-sm text-foreground-muted">
            You're all set. You can now sign in to Hader AI.
          </p>
          <Button asChild>
            <Link href="/login">Continue to sign in</Link>
          </Button>
        </>
      ) : null}

      {state === 'error' ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Verification failed</h1>
          <p className="text-sm text-foreground-muted">{error}</p>
          <Link href="/login" className="text-sm text-brand-500 hover:underline">
            Back to sign in →
          </Link>
        </>
      ) : null}
    </div>
  );
}
