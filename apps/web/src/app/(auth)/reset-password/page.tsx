'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { resetPasswordBodySchema, type ResetPasswordBody } from '@platform/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

export default function ResetPasswordPage() {
  // useSearchParams triggers a CSR bailout that Next 15 now requires to be
  // wrapped in Suspense so the build can render a safe fallback.
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-full" />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token') ?? '';

  const form = useForm<ResetPasswordBody>({
    resolver: zodResolver(resetPasswordBodySchema),
    defaultValues: { token, password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api.post('/api/v1/auth/reset-password', values, { anonymous: true });
      toast.success('Password updated. Please sign in.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Reset failed. Please try again.');
    }
  });

  if (!token) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Invalid reset link</h1>
        <p className="text-sm text-foreground-muted">
          This password reset link is missing or invalid. Request a new one.
        </p>
        <Link href="/forgot-password" className="text-sm text-brand-500 hover:underline">
          Request a new link →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Make it strong — 12+ characters with mixed case and a number.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <input type="hidden" {...form.register('token')} />
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
          {form.formState.errors.password ? (
            <p className="text-xs text-red-600">{form.formState.errors.password.message}</p>
          ) : null}
        </div>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Update password
        </Button>
      </form>
    </div>
  );
}
