'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { acceptInvitationBodyWithoutTokenSchema, type AcceptInvitationBody } from '@platform/shared';
import { useParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

type FormValues = Omit<AcceptInvitationBody, 'token'>;

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { refresh } = useSession();
  const form = useForm<FormValues>({
    resolver: zodResolver(acceptInvitationBodyWithoutTokenSchema),
    defaultValues: { firstName: '', lastName: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      // Accepting returns a session (the API logs the invitee in) — adopt the
      // token, hydrate the session, and go straight to the app. No bounce to
      // /login where a brand-new user would have no password to enter.
      const res = await api.post<{
        accessToken: string | null;
        expiresAt: string | null;
        requiresLogin: boolean;
      }>(`/api/v1/auth/invites/${params.token}/accept`, values, { anonymous: true });
      // H-4 — an existing account is added to the org but is NOT auto-logged-in
      // off the invite token; send them to sign in normally.
      if (res.requiresLogin || !res.accessToken || !res.expiresAt) {
        toast.success('You have joined the organization — please sign in to continue.');
        router.replace('/login');
        return;
      }
      setAccessToken(res.accessToken, res.expiresAt);
      await refresh();
      toast.success('Welcome aboard! 🎉');
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Could not accept invitation.');
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#cfc0a9]">Accept your invitation</h1>
        <p className="mt-1 text-sm text-[#cfc0a9]/70">
          Set up your account to join the organization.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="firstName" className="text-[#cfc0a9]">First name</Label>
            <Input id="firstName" {...form.register('firstName')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lastName" className="text-[#cfc0a9]">Last name</Label>
            <Input id="lastName" {...form.register('lastName')} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-[#cfc0a9]">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
          <p className="text-xs text-[#cfc0a9]/60">
            12+ characters with uppercase, lowercase, and a number.
          </p>
          {form.formState.errors.password ? (
            <p className="text-xs text-red-300">{form.formState.errors.password.message}</p>
          ) : null}
        </div>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Accept invitation
        </Button>
      </form>
    </div>
  );
}
