'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { signupBodySchema, type SignupBody } from '@platform/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

function slugifyOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export default function SignupPage() {
  const router = useRouter();
  const form = useForm<SignupBody>({
    resolver: zodResolver(signupBodySchema),
    defaultValues: {
      email: '',
      password: '',
      firstName: '',
      lastName: '',
      organizationName: '',
      organizationSlug: '',
    },
  });

  // Auto-derive slug from org name if user hasn't typed a custom slug.
  const orgName = form.watch('organizationName');
  const slugDirty = form.formState.dirtyFields.organizationSlug;
  useEffect(() => {
    if (!slugDirty && orgName) {
      form.setValue('organizationSlug', slugifyOrgName(orgName), { shouldValidate: false });
    }
  }, [orgName, slugDirty, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api.post('/api/v1/auth/signup', values, { anonymous: true });
      toast.success('Account created. Check your email to verify your address.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Sign-up failed. Please try again.');
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your organization</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          You'll be the admin. You can invite teammates after sign-up.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input id="firstName" autoComplete="given-name" {...form.register('firstName')} />
            {form.formState.errors.firstName ? (
              <p className="text-xs text-red-600">{form.formState.errors.firstName.message}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lastName">Last name</Label>
            <Input id="lastName" autoComplete="family-name" {...form.register('lastName')} />
            {form.formState.errors.lastName ? (
              <p className="text-xs text-red-600">{form.formState.errors.lastName.message}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          {form.formState.errors.email ? (
            <p className="text-xs text-red-600">{form.formState.errors.email.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
          <p className="text-xs text-foreground-subtle">
            12+ characters, with uppercase, lowercase, and a number.
          </p>
          {form.formState.errors.password ? (
            <p className="text-xs text-red-600">{form.formState.errors.password.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="organizationName">Organization name</Label>
          <Input id="organizationName" {...form.register('organizationName')} />
          {form.formState.errors.organizationName ? (
            <p className="text-xs text-red-600">{form.formState.errors.organizationName.message}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="organizationSlug">Organization URL</Label>
          <div className="flex items-center overflow-hidden rounded-md border border-border bg-white shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-400">
            <span className="px-3 text-xs text-foreground-subtle">aligned.app/</span>
            <Input
              id="organizationSlug"
              className="border-0 shadow-none focus-visible:ring-0 focus-visible:border-0"
              {...form.register('organizationSlug')}
            />
          </div>
          {form.formState.errors.organizationSlug ? (
            <p className="text-xs text-red-600">{form.formState.errors.organizationSlug.message}</p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Create organization
        </Button>
      </form>

      <p className="text-sm text-foreground-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-500 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
