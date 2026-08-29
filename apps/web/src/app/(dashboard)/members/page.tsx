'use client';

import { ORG_ROLE_LABELS, ORG_ROLES, pageAccessOptions, type OrgRole } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { fullName, initials } from '@/lib/utils';

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  pageAccess?: string[] | null;
  status: 'pending' | 'active' | 'disabled';
  isActive: boolean;
  protected?: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedById: string;
  invitedByName: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

const STATUS_BADGE: Record<Member['status'], { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-50 text-emerald-700' },
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700' },
  disabled: { label: 'Disabled', className: 'bg-slate-100 text-slate-600' },
};

export default function MembersPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pageAccessTarget, setPageAccessTarget] = useState<Member | null>(null);
  // Opt-in (owner directive 2026-08-29): the page-access UI stays hidden
  // until HQ enables page_permissions for this org.
  const pagePermsOn =
    !!session && !(session.organization?.disabledFeatures ?? []).includes('page_permissions');
  const isAdmin = session?.organization.role === 'admin';

  const membersQuery = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ data: Member[] }>('/api/v1/members'),
  });

  const invitesQuery = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<{ data: Invitation[] }>('/api/v1/invitations'),
    enabled: isAdmin,
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrgRole }) =>
      api.patch(`/api/v1/members/${id}/role`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Role updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/members/${id}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member deactivated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Deactivate failed'),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/members/${id}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member reactivated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Reactivate failed'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/members/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Remove failed'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/invitations/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invitation revoked');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Revoke failed'),
  });

  // The generated temporary password, shown once in a dialog for the admin to copy.
  const [resetResult, setResetResult] = useState<{ email: string; password: string } | null>(null);
  const resetPasswordMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { email: string; temporaryPassword: string | null } }>(
        `/api/v1/members/${id}/reset-password`,
        {},
      ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      if (res.data.temporaryPassword) {
        setResetResult({ email: res.data.email, password: res.data.temporaryPassword });
      }
      toast.success('Password reset — the member’s sessions were revoked');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Reset failed'),
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="Manage who has access to this organization and what they can do."
        actions={
          isAdmin ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-4" /> Invite member
            </Button>
          ) : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-3 sm:px-6">Member</th>
                  <th className="px-6 py-3">Role</th>
                  <th className="hidden px-6 py-3 sm:table-cell">Status</th>
                  <th className="hidden px-6 py-3 md:table-cell">Last login</th>
                  <th className="w-12 px-4 py-3 sm:px-6" />
                </tr>
              </thead>
              <tbody>
                {membersQuery.isLoading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={`s-${i}`} className="border-b border-border last:border-0">
                        <td className="px-4 py-4 sm:px-6">
                          <div className="flex items-center gap-3">
                            <Skeleton className="size-9 rounded-full" />
                            <div className="space-y-1.5">
                              <Skeleton className="h-4 w-32" />
                              <Skeleton className="h-3 w-40" />
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <Skeleton className="h-4 w-20" />
                        </td>
                        <td className="hidden px-6 py-4 sm:table-cell">
                          <Skeleton className="h-5 w-16 rounded-full" />
                        </td>
                        <td className="hidden px-6 py-4 md:table-cell">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="px-4 py-4 sm:px-6" />
                      </tr>
                    ))
                  : null}

                {membersQuery.data?.data.map((m) => {
                  const badge = STATUS_BADGE[m.status];
                  const isSelf = session?.user.id === m.userId;
                  return (
                    <tr key={m.membershipId} className="border-b border-border last:border-0">
                      <td className="px-4 py-4 sm:px-6">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback>{initials(m.firstName, m.lastName, m.email)}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">
                              {fullName(m.firstName, m.lastName, m.email)}
                              {isSelf ? <span className="ml-2 text-xs text-foreground-subtle">(you)</span> : null}
                              {m.protected ? (
                                <span className="ml-2 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                                  Protected
                                </span>
                              ) : null}
                            </p>
                            <p className="text-xs text-foreground-subtle">{m.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {isAdmin && !isSelf && !m.protected ? (
                          <Select
                            value={m.role}
                            onValueChange={(role) =>
                              roleMutation.mutate({ id: m.membershipId, role: role as OrgRole })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ORG_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ORG_ROLE_LABELS[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-foreground-muted">{ORG_ROLE_LABELS[m.role]}</span>
                        )}
                      </td>
                      <td className="hidden px-6 py-4 sm:table-cell">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${badge.className}`}>
                          {badge.label}
                        </span>
                        {!m.isActive ? (
                          <span className="ml-2 text-xs text-foreground-subtle">deactivated</span>
                        ) : null}
                      </td>
                      <td className="hidden px-6 py-4 text-foreground-muted md:table-cell">
                        {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-4 text-right sm:px-6">
                        {isAdmin && !isSelf && !m.protected ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {m.isActive ? (
                                <DropdownMenuItem
                                  onSelect={() => deactivateMutation.mutate(m.membershipId)}
                                >
                                  Deactivate
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onSelect={() => reactivateMutation.mutate(m.membershipId)}
                                >
                                  Reactivate
                                </DropdownMenuItem>
                              )}
                              {pagePermsOn && m.role !== 'admin' ? (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onSelect={() => setPageAccessTarget(m)}>
                                    Page access…
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={async () => {
                                  const confirmed = await confirmDialog({
                                    title: `Reset password for ${fullName(m.firstName, m.lastName, m.email)}?`,
                                    body:
                                      'A new temporary password will be generated and shown to you once. ' +
                                      'The member’s active sessions are revoked, so they must sign in with the ' +
                                      'new password (they can change it afterward in their settings).',
                                    confirmLabel: 'Reset password',
                                  });
                                  if (confirmed) resetPasswordMutation.mutate(m.membershipId);
                                }}
                              >
                                Reset password
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-700"
                                onSelect={async () => {
                                  const confirmed = await confirmDialog({
                                    title: `Remove ${fullName(m.firstName, m.lastName, m.email)}?`,
                                    body:
                                      'They will lose access to this organization immediately and their sessions will be revoked. ' +
                                      'Their account is not deleted — you can re-invite them later.',
                                    confirmLabel: 'Remove member',
                                    destructive: true,
                                  });
                                  if (confirmed) removeMutation.mutate(m.membershipId);
                                }}
                              >
                                Remove from organization
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {invitesQuery.data?.data.filter((i) => i.status === 'pending').length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-foreground-muted">
                No pending invitations.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-3 sm:px-6">Email</th>
                      <th className="px-6 py-3">Role</th>
                      <th className="hidden px-6 py-3 md:table-cell">Invited by</th>
                      <th className="hidden px-6 py-3 sm:table-cell">Expires</th>
                      <th className="w-12 px-4 py-3 sm:px-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {invitesQuery.data?.data
                      .filter((i) => i.status === 'pending')
                      .map((i) => (
                        <tr key={i.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-4 sm:px-6">{i.email}</td>
                          <td className="px-6 py-4 text-foreground-muted">{ORG_ROLE_LABELS[i.role]}</td>
                          <td className="hidden px-6 py-4 text-foreground-muted md:table-cell">{i.invitedByName ?? '—'}</td>
                          <td className="hidden px-6 py-4 text-foreground-muted sm:table-cell">
                            {new Date(i.expiresAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-4 text-right sm:px-6">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => revokeMutation.mutate(i.id)}
                              aria-label="Revoke invitation"
                            >
                              <X className="size-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} pagePermsOn={pagePermsOn} />
      <PageAccessDialog target={pageAccessTarget} onClose={() => setPageAccessTarget(null)} />

      <Dialog
        open={resetResult !== null}
        onOpenChange={(open) => {
          if (!open) setResetResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              Share this with {resetResult?.email}. It won’t be shown again. They’ll sign in with it
              and can change it in their settings.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded-md border border-border bg-surface-muted px-3 py-2 font-mono text-sm">
              {resetResult?.password}
            </code>
            <Button
              variant="secondary"
              onClick={() => {
                if (!resetResult) return;
                void navigator.clipboard.writeText(resetResult.password);
                toast.success('Copied');
              }}
            >
              Copy
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setResetResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// F1 — the checkbox grid both the invite dialog and the per-member editor
// share. value === null means "all pages" (the backward-compatible default).
function PageAccessGrid({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const options = pageAccessOptions();
  const allOn = value === null;
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={allOn} onChange={(e) => onChange(e.target.checked ? null : options.map((o) => o.key))} />
        All pages (default)
      </label>
      {!allOn ? (
        <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
          {options.map((o) => (
            <label key={o.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(value ?? []).includes(o.key)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...(value ?? []), o.key]
                      : (value ?? []).filter((k) => k !== o.key),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-foreground-muted">
          Untick to choose exactly which pages this member can open. Everything else is hidden
          from their sidebar and blocked, in the portal and the API.
        </p>
      )}
    </div>
  );
}

function PageAccessDialog({ target, onClose }: { target: Member | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string[] | null>(null);
  // Reset the draft whenever a different member is opened.
  const [forId, setForId] = useState<string | null>(null);
  if (target && target.membershipId !== forId) {
    setForId(target.membershipId);
    setValue(target.pageAccess ?? null);
  }
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/members/${target!.membershipId}/page-access`, { pageAccess: value }),
    onSuccess: () => {
      toast.success('Page access updated');
      queryClient.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Page access — {target ? fullName(target.firstName, target.lastName, target.email) : ''}
          </DialogTitle>
          <DialogDescription>
            Choose which pages this member can open. Their role ({target?.role}) still controls
            what they can DO on those pages. Changes apply within a minute.
          </DialogDescription>
        </DialogHeader>
        <PageAccessGrid value={value} onChange={setValue} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  pagePermsOn,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pagePermsOn: boolean;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('editor');
  const [pageAccess, setPageAccess] = useState<string[] | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (vars: { email: string; role: OrgRole; pageAccess?: string[] | null }) =>
      api.post('/api/v1/invitations', vars),
    onSuccess: () => {
      toast.success('Invitation sent');
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      onOpenChange(false);
      setEmail('');
      setRole('editor');
      setPageAccess(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Could not invite'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They'll receive an email with a link to join this organization. Invitations expire in 7 days.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            inviteMutation.mutate({
              email,
              role,
              ...(role !== 'admin' && pageAccess !== null ? { pageAccess } : {}),
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORG_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ORG_ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {pagePermsOn && role !== 'admin' ? (
            <div className="space-y-1.5">
              <Label>Page access</Label>
              <PageAccessGrid value={pageAccess} onChange={setPageAccess} />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={inviteMutation.isPending}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
