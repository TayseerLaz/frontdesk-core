'use client';

import { brand } from '@/lib/brand';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@platform/shared';
import { ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

type Step = 'credentials' | 'totp';

// Literal hexes — bypass the portal theme tokens because brand-500
// flips to Signal Red in dark mode. The auth shell is locked to the
// brand-book Brand panel + panel ink pairing regardless of system theme.
const BRAND_PANEL = '#11334d';
const BRAND_PANEL_INK = '#cddfee';

function BrandIconMark({ size = 96 }: { size?: number }) {
  // URL is /app/-prefixed because Next.js's basePath does not rewrite
  // string URLs embedded in inline style attributes. At the root domain
  // `/platform-icon.png` would fall through Caddy's try_files to the
  // marketing site's index.html — silently breaking the mask.
  return (
    <span
      role="img"
      aria-label={brand.name}
      className="inline-block"
      style={{
        width: size,
        height: size,
        backgroundColor: BRAND_PANEL_INK,
        WebkitMaskImage: 'url(/app/platform-icon.png)',
        maskImage: 'url(/app/platform-icon.png)',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  );
}

// Inputs: transparent on Brand panel with panel-ink border + panel-ink text. Focus
// ramps the border to full panel-ink with a soft panel-ink ring.
const INPUT =
  'w-full rounded-lg border border-[#cddfee]/40 bg-transparent px-4 py-3 text-[15px] text-[#cddfee] placeholder:text-[#cddfee]/45 outline-none transition focus:border-[#cddfee] focus:ring-2 focus:ring-[#cddfee]/25';

// Outline pill — panel-ink border + panel-ink text → hover inverts to filled
// panel-ink with Brand panel text.
const PRIMARY_BTN =
  'w-full rounded-lg border-2 border-[#cddfee] bg-transparent px-6 py-3 text-[15px] font-semibold text-[#cddfee] transition hover:bg-[#cddfee] hover:text-[#11334d] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[#cddfee]';

const LINK =
  'rounded px-1.5 py-0.5 font-semibold text-[#cddfee] transition hover:bg-[#cddfee] hover:text-[#11334d]';

const LINK_SUBTLE =
  'rounded px-1.5 py-0.5 font-medium text-[#cddfee]/70 transition hover:bg-[#cddfee] hover:text-[#11334d]';

export default function LoginPage() {
  const router = useRouter();
  const { refresh, status } = useSession();
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<Step>('credentials');

  // Already signed in? Bounce straight into the app. This is what makes the
  // phone "back button" behave: after login we replace() to the dashboard, but
  // if the browser ever lands back on /login while the refresh cookie is still
  // valid (back gesture, stale bookmark, tab restore), we redirect instead of
  // showing the sign-in form — which previously looked like being logged out.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  const stash = useRef<{ email: string; password: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (step === 'totp') totpInputRef.current?.focus();
  }, [step]);

  const finishLogin = async (res: { accessToken: string; expiresAt: string }) => {
    setAccessToken(res.accessToken, res.expiresAt);
    await refresh();
    // replace(), not push(): drop /login from the history stack so the phone
    // back gesture doesn't return to the sign-in form after logging in.
    router.replace('/dashboard');
  };

  const onSubmitCredentials = form.handleSubmit(async (values) => {
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        values,
        { anonymous: true },
      );
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_REQUIRED') {
        stash.current = { email: values.email, password: values.password };
        setTotpCode('');
        setTotpError(null);
        setStep('totp');
        return;
      }
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Could not sign in. Please try again.');
    }
  });

  const onSubmitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stash.current) {
      setStep('credentials');
      return;
    }
    const value = totpCode.trim();
    if (value.length < 6) {
      setTotpError('Enter your 6-digit code (or an 8-character recovery code).');
      return;
    }
    setVerifying(true);
    setTotpError(null);
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        { ...stash.current, totpCode: value },
        { anonymous: true },
      );
      stash.current = null;
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_INVALID') {
        setTotpError('Invalid code. Try again — or use a recovery code.');
      } else if (err instanceof ApiError) {
        setTotpError(err.payload.message);
      } else {
        setTotpError('Could not verify the code. Please try again.');
      }
    } finally {
      setVerifying(false);
    }
  };

  // Redirect in flight (already authenticated) — don't flash the sign-in form.
  if (status === 'authenticated') return null;

  if (step === 'credentials') {
    return (
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <BrandIconMark size={96} />
        <h1
          className="mt-8 text-5xl font-extrabold leading-[0.95] tracking-[-0.04em] text-[#cddfee] sm:text-6xl"
        >
          Welcome{' '}
          <span
            className="font-normal"
            style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
          >
            back.
          </span>
        </h1>
        <p className="mt-3 text-sm text-[#cddfee]/70">
          Sign in to continue to your {brand.name} workspace.
        </p>

        <form onSubmit={onSubmitCredentials} className="mt-10 w-full space-y-4 text-left">
          <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              className={INPUT}
              aria-invalid={!!form.formState.errors.email}
              {...form.register('email')}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="password" className="text-sm font-medium text-[#cddfee]">
                Password
              </label>
              <Link href="/forgot-password" className={`text-xs ${LINK_SUBTLE}`}>
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                className={`${INPUT} pr-12`}
                aria-invalid={!!form.formState.errors.password}
                {...form.register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-[#cddfee]/60 transition hover:bg-[#cddfee] hover:text-[#11334d]"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="text-xs font-medium text-[#cddfee]/90">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className={`${PRIMARY_BTN} mt-2`}
          >
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  // Two-factor — same pattern. panel-ink shield ring on Brand panel.
  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      <div className="flex size-24 items-center justify-center rounded-full border-2 border-[#cddfee]/40">
        <ShieldCheck className="size-10 text-[#cddfee]" />
      </div>
      <h1 className="mt-8 text-5xl font-extrabold leading-[0.95] tracking-[-0.04em] text-[#cddfee] sm:text-6xl">
        Verify it's{' '}
        <span
          className="font-normal"
          style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
        >
          you.
        </span>
      </h1>
      <p className="mt-3 text-sm text-[#cddfee]/70">
        Open your authenticator app and enter the 6-digit code.
      </p>
      <p className="mt-1 text-xs text-[#cddfee]/60">
        Signing in as <span className="font-medium text-[#cddfee]">{stash.current?.email}</span>
      </p>

      <form onSubmit={onSubmitTotp} className="mt-10 w-full space-y-4">
        <input
          ref={totpInputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={20}
          placeholder="000000"
          value={totpCode}
          onChange={(e) => {
            setTotpCode(e.target.value);
            setTotpError(null);
          }}
          className={`${INPUT} text-center font-mono text-lg tracking-[0.5em]`}
          aria-invalid={!!totpError}
        />
        {totpError ? (
          <p className="text-center text-xs font-medium text-[#cddfee]/90">{totpError}</p>
        ) : (
          <p className="text-center text-xs text-[#cddfee]/60">
            Lost your authenticator? Type an 8-character recovery code.
          </p>
        )}

        <button
          type="submit"
          disabled={verifying || totpCode.trim().length < 6}
          className={PRIMARY_BTN}
        >
          {verifying ? 'Verifying…' : 'Verify & continue'}
        </button>

        <button
          type="button"
          onClick={() => {
            stash.current = null;
            setTotpCode('');
            setTotpError(null);
            setStep('credentials');
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-sm text-[#cddfee]/70 transition hover:bg-[#cddfee] hover:text-[#11334d]"
        >
          <ArrowLeft className="size-3.5" /> Use a different account
        </button>
      </form>
    </div>
  );
}

// Silence eslint about unused constants — they document the locked
// palette + can be imported elsewhere.
void BRAND_PANEL;
void BRAND_PANEL_INK;

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-[#cddfee]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-[#cddfee]/90" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
