'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  Link2,
  Mail,
  MoreHorizontal,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface Membership {
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  role: string;
  isActive: boolean;
}
interface PlatformUser {
  id: string;
  name: string | null;
  email: string;
  status: string;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  memberships: Membership[];
}
interface UserDetail extends PlatformUser {
  firstName: string | null;
  lastName: string | null;
  activity: {
    id: string;
    action: string;
    entityType: string | null;
    organizationName: string | null;
    createdAt: string;
  }[];
}

function statusVariant(s: string): 'success' | 'warning' | 'muted' {
  return s === 'active' ? 'success' : s === 'pending' ? 'warning' : 'muted';
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<PlatformUser | null>(null);

  const list = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ data: PlatformUser[] }>('/api/v1/hq/users'),
  });
  const orgsQuery = useQuery({
    queryKey: ['admin-orgs-min'],
    queryFn: () =>
      api.get<{ data: { id: string; name: string; slug: string }[] }>('/api/v1/hq/orgs'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/hq/users/${id}`),
    onSuccess: () => {
      toast.success('Account deleted');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      qc.invalidateQueries({ queryKey: ['admin-system'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not delete account'),
  });
  const users = list.data?.data ?? [];
  const q = search.trim().toLowerCase();
  const filtered = q
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          (u.name ?? '').toLowerCase().includes(q) ||
          u.memberships.some((m) => (m.organizationName ?? '').toLowerCase().includes(q)),
      )
    : users;

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account on the platform — emails, organizations, activity. Use the actions menu on a row to manage, link to an organization, or delete an account."
      />

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border p-3">
            <div className="relative max-w-sm">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email, or organization…"
                className="pl-8"
                aria-label="Search users"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-3 sm:px-6">User</th>
                  <th className="hidden px-6 py-3 md:table-cell">Organizations</th>
                  <th className="hidden px-6 py-3 sm:table-cell">Status</th>
                  <th className="hidden px-6 py-3 lg:table-cell">Joined</th>
                  <th className="w-12 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {list.isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-4">
                      <div className="space-y-3">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <Skeleton key={i} className="h-10 w-full" />
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-foreground-muted">
                      No users match “{search}”.
                    </td>
                  </tr>
                ) : (
                  filtered.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-border last:border-0 hover:bg-surface-muted/30"
                    >
                      <td className="px-4 py-3 sm:px-6">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{u.name ?? u.email.split('@')[0]}</span>
                          {u.isSuperAdmin ? (
                            <Badge variant="default" className="gap-1">
                              <ShieldCheck className="size-3" /> HQ admin
                            </Badge>
                          ) : null}
                          {!u.emailVerified ? <Badge variant="warning">unverified</Badge> : null}
                        </div>
                        <p className="text-xs text-foreground-muted">{u.email}</p>
                      </td>
                      <td className="hidden px-6 py-3 md:table-cell">
                        {u.memberships.length === 0 ? (
                          <span className="text-xs italic text-foreground-subtle">none</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {u.memberships.map((m) => (
                              <span
                                key={m.organizationId}
                                className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted"
                              >
                                {m.organizationName ?? m.organizationSlug} · {m.role}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="hidden px-6 py-3 sm:table-cell">
                        <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                      </td>
                      <td className="hidden px-6 py-3 text-foreground-muted lg:table-cell">
                        {formatRelative(u.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" aria-label="User actions">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onClick={() => setOpenFor(u.id)}>
                              <Settings2 className="size-4" /> Manage account
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setLinkFor(u)}>
                              <Link2 className="size-4" /> Link to organization
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
                              onClick={async () => {
                                if (
                                  await confirmDialog({
                                    title: `Delete ${u.name ?? u.email}?`,
                                    body: 'This removes the account from every organization, frees the email, and permanently disables login. This cannot be undone.',
                                    confirmLabel: 'Delete account',
                                    destructive: true,
                                  })
                                ) {
                                  del.mutate(u.id);
                                }
                              }}
                            >
                              <Trash2 className="size-4" /> Delete account
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {openFor ? <UserDetailDialog userId={openFor} onClose={() => setOpenFor(null)} /> : null}
      {linkFor ? (
        <LinkOrgDialog
          user={linkFor}
          orgs={orgsQuery.data?.data ?? []}
          onClose={() => setLinkFor(null)}
          onLinked={() => {
            qc.invalidateQueries({ queryKey: ['admin-users'] });
            setLinkFor(null);
          }}
        />
      ) : null}
    </>
  );
}

function LinkOrgDialog({
  user,
  orgs,
  onClose,
  onLinked,
}: {
  user: PlatformUser;
  orgs: { id: string; name: string; slug: string }[];
  onClose: () => void;
  onLinked: () => void;
}) {
  // Orgs the user isn't already a member of.
  const memberOrgIds = new Set(user.memberships.map((m) => m.organizationId));
  const available = orgs.filter((o) => !memberOrgIds.has(o.id));
  const [orgId, setOrgId] = useState('');
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('admin');

  const link = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hq/users/${user.id}/link-org`, { organizationId: orgId, role }),
    onSuccess: () => {
      toast.success('Account linked to organization');
      onLinked();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not link account'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link to organization</DialogTitle>
          <DialogDescription>
            Add <span className="font-medium">{user.name ?? user.email}</span> as a member of
            another tenant.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Organization</Label>
            <Select value={orgId} onValueChange={setOrgId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a tenant…" />
              </SelectTrigger>
              <SelectContent>
                {available.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-foreground-muted">
                    Already in every organization.
                  </div>
                ) : (
                  available.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'editor' | 'viewer')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => link.mutate()} loading={link.isPending} disabled={!orgId}>
            <Link2 className="size-4" /> Link account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDetailDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => api.get<{ data: UserDetail }>(`/api/v1/hq/users/${userId}`),
  });
  const u = detail.data?.data;

  const [form, setForm] = useState<{
    firstName: string;
    lastName: string;
    status: string;
    emailVerified: boolean;
    isSuperAdmin: boolean;
  } | null>(null);

  useEffect(() => {
    if (u)
      setForm({
        firstName: u.firstName ?? '',
        lastName: u.lastName ?? '',
        status: u.status,
        emailVerified: u.emailVerified,
        isSuperAdmin: u.isSuperAdmin,
      });
  }, [u]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/hq/users/${userId}/account`, {
        firstName: form?.firstName.trim() || null,
        lastName: form?.lastName.trim() || null,
        status: form?.status,
        emailVerified: form?.emailVerified,
        isSuperAdmin: form?.isSuperAdmin,
      }),
    onSuccess: () => {
      toast.success('User updated');
      qc.invalidateQueries({ queryKey: ['admin-user', userId] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      qc.invalidateQueries({ queryKey: ['admin-system'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not update user'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{u?.name ?? u?.email ?? 'User'}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Mail className="size-3.5" /> {u?.email}
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading || !u || !form ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
            {/* Edit form */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                Edit account
              </h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>First name</Label>
                  <Input
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Last name</Label>
                  <Input
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Account status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v })}
                >
                  <SelectTrigger className="max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">Email verified</p>
                  <p className="text-xs text-foreground-muted">
                    Manually mark the email as verified (bypasses the link).
                  </p>
                </div>
                <Switch
                  checked={form.emailVerified}
                  onCheckedChange={(c) => setForm({ ...form, emailVerified: c })}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">HQ admin</p>
                  <p className="text-xs text-foreground-muted">
                    Grants full cross-tenant access. Use sparingly.
                  </p>
                </div>
                <Switch
                  checked={form.isSuperAdmin}
                  onCheckedChange={(c) => setForm({ ...form, isSuperAdmin: c })}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={() => save.mutate()} loading={save.isPending}>
                  <Save className="size-4" /> Save changes
                </Button>
              </div>
            </section>

            {/* Organizations */}
            <section className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                <Building2 className="size-3.5" /> Organizations ({u.memberships.length})
              </h4>
              {u.memberships.length === 0 ? (
                <p className="text-sm italic text-foreground-muted">No org membership.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {u.memberships.map((m) => (
                    <li
                      key={m.organizationId}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span>{m.organizationName ?? m.organizationSlug}</span>
                      <span className="flex items-center gap-2 text-xs text-foreground-muted">
                        <Badge variant="muted">{m.role}</Badge>
                        {!m.isActive ? <span className="text-rose-600">inactive</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Activity */}
            <section className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                <Activity className="size-3.5" /> Recent activity ({u.activity.length})
              </h4>
              {u.activity.length === 0 ? (
                <p className="text-sm italic text-foreground-muted">No recorded activity.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {u.activity.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="text-sm">
                        {a.action.replace(/_/g, ' ')}
                        {a.organizationName ? (
                          <span className="text-foreground-muted"> · {a.organizationName}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-foreground-subtle">
                        {formatRelative(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
