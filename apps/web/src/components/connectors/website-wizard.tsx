'use client';

// F10 — "Connect your website" product-feed wizard (roadmap 2026-08-26).
// A guided, non-technical path onto the existing connector engine: fetch a
// sample from the site's API, visually map its fields onto Hader's product
// shape with a live preview, pick a schedule, save. The result is a normal
// ApiConnector row with a v2 columnMapping — the Day-3 sync worker does the
// rest (scheduled pulls, upserts, image attach, sync-run history).
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Globe, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

interface PreviewData {
  ok: boolean;
  error: string | null;
  recordCount: number | null;
  arrayPaths: string[];
  sourcePaths: string[];
  suggestedFields: Record<string, string>;
  rawSample: string | null;
  mappedPreviews: { mapped: Record<string, unknown>; problems: string[] }[];
}

const TARGET_FIELDS: [key: string, label: string, required: boolean][] = [
  ['name', 'Product name', true],
  ['sku', 'SKU / unique id', true],
  ['priceMinor', 'Price', true],
  ['currency', 'Currency (3-letter)', false],
  ['shortDescription', 'Short description', false],
  ['description', 'Description', false],
  ['stockQuantity', 'Stock quantity', false],
  ['categorySlug', 'Category', false],
  ['imageUrls', 'Images', false],
  ['isAvailable', 'Available flag', false],
];

const SCHEDULES: [cron: string, label: string][] = [
  ['', 'Manual only (run it yourself)'],
  ['0 * * * *', 'Every hour'],
  ['0 */6 * * *', 'Every 6 hours (recommended)'],
  ['0 3 * * *', 'Once a day (03:00)'],
];

const selectCls =
  'h-9 w-full rounded-md border border-border bg-surface px-2 text-sm';

export function WebsiteWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('My website');
  const [url, setUrl] = useState('');
  const [authKind, setAuthKind] = useState<'none' | 'bearer' | 'api_key' | 'basic'>('none');
  const [cred, setCred] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [arrayPath, setArrayPath] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [priceUnit, setPriceUnit] = useState<'major' | 'minor'>('major');
  const [schedule, setSchedule] = useState('0 */6 * * *');
  const [runNow, setRunNow] = useState(true);

  const authConfig = () => {
    if (authKind === 'bearer') return { token: cred.token ?? '' };
    if (authKind === 'api_key') return { headerName: cred.headerName ?? '', value: cred.value ?? '' };
    if (authKind === 'basic') return { username: cred.username ?? '', password: cred.password ?? '' };
    return {};
  };

  const fetchPreview = useMutation({
    mutationFn: (withMapping: boolean) =>
      api.post<{ data: PreviewData }>('/api/v1/connectors/preview', {
        endpointUrl: url,
        authKind,
        authConfig: authConfig(),
        ...(withMapping
          ? { mapping: { arrayPath: arrayPath || null, fields, priceUnit } }
          : arrayPath
            ? { mapping: { arrayPath } }
            : {}),
      }),
    onSuccess: (res, withMapping) => {
      setPreview(res.data);
      if (!res.data.ok) {
        toast.error(res.data.error ?? 'Could not read the feed');
        return;
      }
      if (!withMapping) {
        // First successful fetch: adopt the detected path + suggested mapping
        // (only where the operator hasn't chosen already).
        if (!arrayPath && res.data.arrayPaths.length > 0) setArrayPath(res.data.arrayPaths[0]!);
        setFields((prev) => (Object.keys(prev).length > 0 ? prev : res.data.suggestedFields));
        setStep(2);
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Preview failed'),
  });

  const create = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ data: { id: string } }>('/api/v1/connectors', {
        name: name.trim() || 'My website',
        entityKind: 'product',
        endpointUrl: url,
        authKind,
        authConfig: authConfig(),
        scheduleCron: schedule || null,
        columnMapping: { __v: 2, arrayPath: arrayPath || null, fields, priceUnit },
      });
      if (runNow) {
        await api.post(`/api/v1/connectors/${created.data.id}/sync`, {}).catch(() => undefined);
      }
      return created;
    },
    onSuccess: () => {
      toast.success(runNow ? 'Website connected — first import is running' : 'Website connected');
      onCreated();
      onOpenChange(false);
      setStep(1);
      setPreview(null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Create failed'),
  });

  const requiredMapped = TARGET_FIELDS.filter(([, , req]) => req).every(([k]) => !!fields[k]);
  const previewProblemsCount =
    preview?.mappedPreviews.reduce((n, p) => n + p.problems.length, 0) ?? 0;

  const credFields = () => {
    if (authKind === 'bearer')
      return (
        <div>
          <Label>Bearer token</Label>
          <Input value={cred.token ?? ''} onChange={(e) => setCred({ token: e.target.value })} type="password" />
        </div>
      );
    if (authKind === 'api_key')
      return (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Header name</Label>
            <Input
              value={cred.headerName ?? ''}
              onChange={(e) => setCred((c) => ({ ...c, headerName: e.target.value }))}
              placeholder="X-Api-Key"
            />
          </div>
          <div>
            <Label>Key</Label>
            <Input
              value={cred.value ?? ''}
              onChange={(e) => setCred((c) => ({ ...c, value: e.target.value }))}
              type="password"
            />
          </div>
        </div>
      );
    if (authKind === 'basic')
      return (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Username</Label>
            <Input value={cred.username ?? ''} onChange={(e) => setCred((c) => ({ ...c, username: e.target.value }))} />
          </div>
          <div>
            <Label>Password</Label>
            <Input
              value={cred.password ?? ''}
              onChange={(e) => setCred((c) => ({ ...c, password: e.target.value }))}
              type="password"
            />
          </div>
        </div>
      );
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <Globe className="size-5" /> Connect your website · step {step} of 3
            </span>
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Point Hader at your website's products API. We'll fetch a sample so you can map its fields — nothing is imported yet."
              : step === 2
                ? 'Match your feed’s fields to Hader’s product fields. The preview below shows exactly how the first products will import.'
                : 'Pick how often to sync. Products update automatically from then on.'}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-3">
            <div>
              <Label>Connection name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My website" />
            </div>
            <div>
              <Label>Products API URL</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mysite.com/api/products" />
            </div>
            <div>
              <Label>Authentication</Label>
              <select
                className={selectCls}
                value={authKind}
                onChange={(e) => {
                  setAuthKind(e.target.value as typeof authKind);
                  setCred({});
                }}
              >
                <option value="none">None (public feed)</option>
                <option value="bearer">Bearer token</option>
                <option value="api_key">API key header</option>
                <option value="basic">Username + password</option>
              </select>
            </div>
            {credFields()}
            {preview && !preview.ok ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {preview.error}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 2 && preview ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <Label>Where the products live in the response</Label>
                <select
                  className={selectCls}
                  value={arrayPath}
                  onChange={(e) => setArrayPath(e.target.value)}
                >
                  {[...new Set(['', ...preview.arrayPaths, arrayPath])].map((p) => (
                    <option key={p || '(root)'} value={p}>
                      {p === '' ? '(response is the list itself / auto)' : p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Prices in the feed are</Label>
                <select
                  className={selectCls}
                  value={priceUnit}
                  onChange={(e) => setPriceUnit(e.target.value as 'major' | 'minor')}
                >
                  <option value="major">Normal amounts (12.50) — convert</option>
                  <option value="minor">Already in cents/minor units</option>
                </select>
              </div>
              <span className="pb-2 text-xs text-foreground-muted">
                {preview.recordCount ?? 0} record{(preview.recordCount ?? 0) === 1 ? '' : 's'} found
              </span>
            </div>

            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {TARGET_FIELDS.map(([key, label, required]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-36 shrink-0 text-xs font-medium">
                    {label}
                    {required ? ' *' : ''}
                  </span>
                  <select
                    className={selectCls}
                    value={fields[key] ?? ''}
                    onChange={(e) =>
                      setFields((f) => {
                        const next = { ...f };
                        if (e.target.value) next[key] = e.target.value;
                        else delete next[key];
                        return next;
                      })
                    }
                  >
                    <option value="">— not mapped —</option>
                    {preview.sourcePaths.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fetchPreview.mutate(true)}
                loading={fetchPreview.isPending}
              >
                <RefreshCw className="size-4" /> Preview the first products
              </Button>
              {preview.mappedPreviews.length > 0 ? (
                <span className={previewProblemsCount > 0 ? 'text-xs text-amber-700' : 'text-xs text-emerald-700'}>
                  {previewProblemsCount > 0
                    ? `${previewProblemsCount} problem${previewProblemsCount === 1 ? '' : 's'} to fix`
                    : 'Looks good ✓'}
                </span>
              ) : null}
            </div>

            {preview.mappedPreviews.length > 0 ? (
              <div className="max-h-56 overflow-auto rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-muted uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-2 py-1.5">Name</th>
                      <th className="px-2 py-1.5">SKU</th>
                      <th className="px-2 py-1.5">Price</th>
                      <th className="px-2 py-1.5">Stock</th>
                      <th className="px-2 py-1.5">Images</th>
                      <th className="px-2 py-1.5">Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.mappedPreviews.map((p, i) => (
                      <tr key={i} className="border-t border-border align-top">
                        <td className="px-2 py-1.5">{String(p.mapped.name ?? '—')}</td>
                        <td className="px-2 py-1.5 font-mono">{String(p.mapped.sku ?? '—')}</td>
                        <td className="px-2 py-1.5">
                          {typeof p.mapped.priceMinor === 'number'
                            ? `${(p.mapped.priceMinor / 100).toFixed(2)} ${String(p.mapped.currency ?? '')}`
                            : '—'}
                        </td>
                        <td className="px-2 py-1.5">{String(p.mapped.stockQuantity ?? '—')}</td>
                        <td className="px-2 py-1.5">
                          {typeof p.mapped.imageUrls === 'string'
                            ? `${p.mapped.imageUrls.split(',').length} image(s)`
                            : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-amber-700">{p.problems.join('; ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <details className="rounded-md border border-border p-2 text-xs">
                <summary className="cursor-pointer text-foreground-subtle">First record (raw)</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{preview.rawSample}</pre>
              </details>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <div>
              <Label>Sync schedule</Label>
              <select className={selectCls} value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                {SCHEDULES.map(([cron, label]) => (
                  <option key={cron || 'manual'} value={cron}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} />
              Import all {preview?.recordCount ?? ''} products now
            </label>
            <p className="text-xs text-foreground-muted">
              Products update in place on every sync (matched by SKU). Images attach on first
              import. You can watch every run on this page afterwards.
            </p>
          </div>
        ) : null}

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div>
            {step > 1 ? (
              <Button variant="ghost" onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
                <ArrowLeft className="size-4" /> Back
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {step === 1 ? (
              <Button onClick={() => fetchPreview.mutate(false)} disabled={!url} loading={fetchPreview.isPending}>
                Fetch sample <ArrowRight className="size-4" />
              </Button>
            ) : step === 2 ? (
              <Button
                onClick={() => setStep(3)}
                disabled={!requiredMapped}
                title={requiredMapped ? undefined : 'Map the required fields (Name, SKU, Price) first'}
              >
                Next <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button onClick={() => create.mutate()} loading={create.isPending}>
                Connect website
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
