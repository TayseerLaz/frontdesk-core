'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordBodySchema, type ForgotPasswordBody } from '@platform/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const form = useForm<ForgotPasswordBody>({
    resolver: zodResolver(forgotPasswordBodySchema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api.post('/api/v1/auth/forgot-password', values, { anonymous: true });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Something went wrong. Please try again.');
    }
  });

  if (submitted) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="text-sm text-foreground-muted">
          If an account exists for that email, we've sent a reset link. The link expires in one hour.
        </p>
        <Link href="/login" className="text-sm text-brand-500 hover:underline">
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Enter the email associated with your account and we'll send you a reset link.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          {form.formState.errors.email ? (
            <p className="text-xs text-red-600">{form.formState.errors.email.message}</p>
          ) : null}
        </div>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Send reset link
        </Button>
      </form>

      <Link href="/login" className="text-sm text-brand-500 hover:underline">
        ← Back to sign in
      </Link>
    </div>
  );
}
