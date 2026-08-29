'use client';

import { Download, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ProfilePage() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Name form state — seeded from session; re-seeded whenever session changes.
  const [firstName, setFirstName] = useState(session?.user.firstName ?? '');
  const [lastName, setLastName] = useState(session?.user.lastName ?? '');
  const [savingName, setSavingName] = useState(false);

  // Password form state.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  if (!session) return null;
  const { user, organization } = session;

  const displayName =
    [firstName, lastName].filter(Boolean).join(' ') || user.email;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      await api.patch('/api/v1/auth/me', { firstName, lastName });
      await refresh();
      toast.success('Profile updated.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error("Couldn't save. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function exportMyData() {
    setExporting(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/account/export`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `account-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success('Your data has been downloaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  async function deleteMyAccount() {
    const confirmed = await confirmDialog({
      title: 'Delete your account?',
      body:
        'This is permanent. Your sessions end immediately, your memberships are revoked, and your profile is anonymised. ' +
        'If you are the last admin of any organization this will be refused — transfer admin first.',
      confirmLabel: 'Delete my account',
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await api.delete('/api/v1/account');
      toast.success('Account deleted. You will be signed out.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Delete failed.');
      setDeleting(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation don't match.");
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/api/v1/auth/change-password', {
        currentPassword,
        newPassword,
      });
      toast.success('Password changed. Other devices have been signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error("Couldn't change password. Please try again.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <>
      <PageHeader
        backHref="/settings"
        backLabel="Settings"
        title="Profile"
        description={`Signed in as ${displayName}.`}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your name</CardTitle>
            <CardDescription>
              Displayed in the top bar and in activity logs.
            </CardDescription>
          </CardHeader>
          <form onSubmit={saveName}>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="profile-firstName">First name</Label>
                  <Input
                    id="profile-firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="profile-lastName">Last name</Label>
                  <Input
                    id="profile-lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-email">Email</Label>
                <Input id="profile-email" value={user.email} readOnly />
                <p className="text-xs text-foreground-subtle">
                  Email can&apos;t be changed from here. Contact support if you
                  need to transfer ownership.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-org">Organization</Label>
                <Input
                  id="profile-org"
                  value={`${organization.name} (${organization.role})`}
                  readOnly
                />
              </div>
              {user.isSuperAdmin ? (
                <p className="text-xs text-brand-500">
                  You have super-admin access across all tenants.
                </p>
              ) : null}
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={savingName}>
                Save changes
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Other devices will be signed out after a successful change.
            </CardDescription>
          </CardHeader>
          <form onSubmit={changePassword}>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={12}
                />
                <p className="text-xs text-foreground-subtle">
                  12+ characters with uppercase, lowercase, and a number.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={savingPassword}>
                Change password
              </Button>
            </CardFooter>
          </form>
        </Card>

        <TwoFactorCard />

        <Card>
          <CardHeader>
            <CardTitle>Export your data</CardTitle>
            <CardDescription>
              Download a JSON file containing your profile, memberships, sessions, issued API keys, and the audit entries you authored. Does not include other tenants&apos; data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" loading={exporting} onClick={exportMyData}>
              <Download className="size-4" /> Download my data
            </Button>
          </CardContent>
        </Card>

        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-red-700">Delete your account</CardTitle>
            <CardDescription>
              Permanently anonymise your profile, revoke every session, and deactivate every membership. Refused if you are the last admin of any organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="danger" loading={deleting} onClick={deleteMyAccount}>
              <Trash2 className="size-4" /> Delete my account
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ---------- TwoFactorCard ---------------------------------------------------
// Phase 5.5 — TOTP 2FA self-service. Setup → enable → recovery codes.
function TwoFactorCard() {
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesRemaining: number } | null>(null);
  const [setupOtpUri, setSetupOtpUri] = useState<string | null>(null);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const res = await api.get<{ data: { enabled: boolean; recoveryCodesRemaining: number } }>(
        '/api/v1/account/2fa/status',
      );
      setStatus(res.data);
    } catch {
      setStatus({ enabled: false, recoveryCodesRemaining: 0 });
    }
  };

  // Fetch on first render.
  if (status === null && !busy) {
    void refresh();
  }

  const beginSetup = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ data: { secret: string; otpauthUri: string } }>(
        '/api/v1/account/2fa/setup',
      );
      setSetupSecret(res.data.secret);
      setSetupOtpUri(res.data.otpauthUri);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : '2FA setup failed');
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      // Sprint 1 M-3 — two-step: this call STAGES the recovery codes; the
      // user must confirm receipt before 2FA actually flips on. Until they
      // click "I've saved them" we don't refresh status (it would still
      // show enabled=false). No lock-out if the response drops here.
      const res = await api.post<{
        data: { recoveryCodes: string[]; pendingConfirmation: true };
      }>('/api/v1/account/2fa/enable', { code });
      setRecoveryCodes(res.data.recoveryCodes);
      setSetupOtpUri(null);
      setSetupSecret(null);
      setCode('');
      toast.success('Code verified — save your recovery codes to finish.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not verify code');
    } finally {
      setBusy(false);
    }
  };

  const confirmRecoveryCodes = async () => {
    setBusy(true);
    try {
      await api.post('/api/v1/account/2fa/confirm-recovery-codes');
      setRecoveryCodes(null);
      toast.success('Two-factor authentication enabled');
      void refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.payload.message : 'Could not confirm recovery codes',
      );
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const c = window.prompt('Enter your current 6-digit 2FA code to disable.');
    if (!c) return;
    setBusy(true);
    try {
      await api.post('/api/v1/account/2fa/disable', { code: c });
      toast.success('Two-factor authentication disabled');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Disable failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          Add a second factor (TOTP) so a stolen password isn&apos;t enough to log in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.enabled ? (
          <>
            <p className="text-sm">
              <strong>Enabled.</strong>{' '}
              <span className="text-foreground-muted">
                {status.recoveryCodesRemaining} recovery code
                {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
              </span>
            </p>
            <Button variant="danger" onClick={disable} loading={busy}>
              Disable 2FA
            </Button>
          </>
        ) : setupOtpUri ? (
          <>
            <p className="text-sm">
              Scan this QR with your authenticator app (Google Authenticator, 1Password, Authy,
              etc.). Can&apos;t scan? Paste the secret manually below.
            </p>

            {/* QR code — white tile around it gives the scanner contrast
                even when the card is on a dark surface. */}
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="rounded-md bg-white p-3 shadow-sm">
                <QRCodeSVG
                  value={setupOtpUri}
                  size={168}
                  level="M"
                  includeMargin={false}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
                />
              </div>

              <div className="flex-1 space-y-2 text-xs">
                <div>
                  <p className="font-medium text-foreground">Manual secret</p>
                  <code className="mt-1 block break-all rounded bg-surface-muted px-2 py-1.5 font-mono">
                    {setupSecret}
                  </code>
                </div>
                <p className="text-foreground-muted">
                  Algorithm SHA-1 · 6 digits · 30-second window — defaults for every authenticator.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="otp-code">Enter the 6-digit code from your app</Label>
              <Input
                id="otp-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                className="font-mono text-center tracking-[0.4em]"
              />
            </div>
            <Button onClick={enable} loading={busy} disabled={code.length !== 6}>
              Verify &amp; enable
            </Button>
          </>
        ) : recoveryCodes ? (
          <>
            <p className="text-sm">
              <strong>Save these recovery codes.</strong> Each can be used once if you lose your
              authenticator. They won&apos;t be shown again. 2FA isn&apos;t active yet — click
              the button below once you&apos;ve copied them somewhere safe.
            </p>
            <pre className="rounded bg-surface-muted p-3 font-mono text-sm">
              {recoveryCodes.join('\n')}
            </pre>
            <Button onClick={confirmRecoveryCodes} loading={busy}>
              I&apos;ve saved them — finish setup
            </Button>
          </>
        ) : (
          <Button onClick={beginSetup} loading={busy}>
            Enable 2FA
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
