'use client';

import type { Category, Product } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImageIcon, Plus, Star, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { VersionHistory } from '@/components/catalog/version-history';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MarkdownEditor } from '@/components/ui/lazy-editor';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { minorToMajorString, parseMoneyMajor } from '@/lib/format';
import { uploadFile } from '@/lib/upload';

interface VariantDraft {
  id?: string;
  sku: string;
  name: string;
  options: Record<string, string>;
  priceMinor: number | null;
  stockQuantity: number | null;
  isAvailable: boolean;
}

const NO_CATEGORY = '__none__';

export default function ProductEditPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const productQuery = useQuery({
    queryKey: ['product', params.id],
    queryFn: () => api.get<{ data: Product }>(`/api/v1/products/${params.id}`),
  });
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const product = productQuery.data?.data;

  if (productQuery.isLoading || !product) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={product.name || 'Untitled product'}
        description={
          <span className="font-mono text-xs text-foreground-subtle">SKU: {product.sku}</span>
        }
        actions={
          <Button variant="secondary" asChild>
            <Link href="/products">
              <ArrowLeft className="size-4" /> Back to list
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailsCard product={product} categories={categoriesQuery.data?.data ?? []} />
          <ImagesCard product={product} />
          <VariantsCard product={product} />
        </div>
        <div className="space-y-6">
          <StatusCard product={product} />
          <VersionHistory
            entityType="product"
            entityId={product.id}
            refetchEntity={() => queryClient.invalidateQueries({ queryKey: ['product', product.id] })}
          />
          <DangerCard product={product} onDelete={() => router.push('/products')} />
        </div>
      </div>
    </>
  );

  function StatusCard({ product }: { product: Product }) {
    const mutation = useMutation({
      mutationFn: (isAvailable: boolean) =>
        api.patch(`/api/v1/products/${product.id}`, { isAvailable }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product', product.id] }),
      onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
    });
    // F5 — customers auto-flagged for back-in-stock on this product. Marking
    // it available notifies every pending watcher (≤5 min, budgeted), so the
    // count doubles as a cost warning before the flip.
    const watchersQ = useQuery({
      queryKey: ['stock-watches', 'product', product.id],
      queryFn: () =>
        api.get<{ data: { id: string; notifiedAt: string | null }[] }>(
          `/api/v1/stock-watches?productId=${product.id}`,
        ),
      staleTime: 30_000,
    });
    const pendingWatchers = (watchersQ.data?.data ?? []).filter((w) => !w.notifiedAt).length;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Available to chatbot</p>
              <p className="text-xs text-foreground-muted">
                When off, the chatbot won't surface this product.
              </p>
            </div>
            <Badge variant={product.isAvailable ? 'success' : 'muted'}>
              {product.isAvailable ? 'Available' : 'Unavailable'}
            </Badge>
          </div>
          {pendingWatchers > 0 ? (
            <p className={pendingWatchers >= 100 ? 'text-xs font-medium text-amber-700' : 'text-xs text-foreground-muted'}>
              🔔 {pendingWatchers} customer{pendingWatchers === 1 ? '' : 's'} waiting for this to be
              back in stock — marking it available sends them a WhatsApp notification.
              {pendingWatchers >= 100 ? ' That is a broadcast-sized send.' : ''}
            </p>
          ) : null}
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => mutation.mutate(!product.isAvailable)}
            loading={mutation.isPending}
          >
            {product.isAvailable ? 'Mark unavailable' : 'Mark available'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  function DangerCard({ product, onDelete }: { product: Product; onDelete: () => void }) {
    const mutation = useMutation({
      mutationFn: () => api.delete(`/api/v1/products/${product.id}`),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['products'] });
        toast.success('Product deleted');
        onDelete();
      },
      onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
    });
    return (
      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="danger"
            className="w-full"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: `Delete "${product.name}"?`,
                  body: 'The product will be hidden from the chatbot immediately. It remains in the database for 30 days.',
                  confirmLabel: 'Delete product',
                  destructive: true,
                })
              ) {
                mutation.mutate();
              }
            }}
            loading={mutation.isPending}
          >
            <Trash2 className="size-4" /> Delete product
          </Button>
        </CardContent>
      </Card>
    );
  }
}

// ---------- Details (auto-save) -------------------------------------------
function DetailsCard({ product, categories }: { product: Product; categories: Category[] }) {
  const queryClient = useQueryClient();
  // Org-level currency drives the price label everywhere. Read it once
  // and pass it down; the per-product currency field is no longer
  // editable (locked to the org default server-side).
  const businessInfoQ = useQuery({
    queryKey: ['business-info'],
    queryFn: () =>
      api.get<{ data: { currency?: string } | null }>('/api/v1/business-info'),
    staleTime: 60_000,
  });
  const orgCurrency = businessInfoQ.data?.data?.currency ?? product.currency;
  const [draft, setDraft] = useState({
    name: product.name,
    sku: product.sku,
    shortDescription: product.shortDescription ?? '',
    description: product.description ?? '',
    priceMajor: minorToMajorString(product.priceMinor, orgCurrency),
    compareAtMajor: minorToMajorString(product.compareAtMinor, orgCurrency),
    categoryId: product.categoryId ?? NO_CATEGORY,
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const skipNext = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset draft when the upstream product changes (e.g. after an unrelated mutation).
  useEffect(() => {
    setDraft({
      name: product.name,
      sku: product.sku,
      shortDescription: product.shortDescription ?? '',
      description: product.description ?? '',
      priceMajor: minorToMajorString(product.priceMinor, orgCurrency),
      compareAtMajor: minorToMajorString(product.compareAtMinor, orgCurrency),
      categoryId: product.categoryId ?? NO_CATEGORY,
    });
    skipNext.current = true;
  }, [product, orgCurrency]);

  const buildPayload = () => ({
    name: draft.name.trim() || 'Untitled product',
    sku: draft.sku.trim() || product.sku,
    shortDescription: draft.shortDescription || null,
    description: draft.description || null,
    priceMinor: parseMoneyMajor(draft.priceMajor, orgCurrency),
    compareAtMinor: parseMoneyMajor(draft.compareAtMajor, orgCurrency),
    // Currency is locked to BusinessInfo.currency server-side.
    categoryId: draft.categoryId === NO_CATEGORY ? null : draft.categoryId,
  });

  // "Completely empty" = nothing worth keeping. A brand-new draft left empty is
  // discarded on leave (below) instead of cluttering the catalog as "Untitled".
  const isEmpty =
    (draft.name.trim() === '' || draft.name.trim() === 'Untitled product') &&
    draft.shortDescription.trim() === '' &&
    draft.description.trim() === '' &&
    !parseMoneyMajor(draft.priceMajor, orgCurrency) &&
    !parseMoneyMajor(draft.compareAtMajor, orgCurrency) &&
    draft.categoryId === NO_CATEGORY &&
    (product.images?.length ?? 0) === 0;
  // Was the product blank when the page opened? Only such never-filled drafts
  // are auto-discarded — an EXISTING product cleared out is never deleted.
  const startedEmptyRef = useRef(
    (product.name.trim() === '' || product.name.trim() === 'Untitled product') &&
      !product.shortDescription &&
      !product.description &&
      product.priceMinor == null &&
      (product.images?.length ?? 0) === 0,
  );
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  // Debounced auto-save (keeps the item as a saved draft as you type).
  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/api/v1/products/${product.id}`, buildPayload());
        setSavedAt(new Date());
        queryClient.invalidateQueries({ queryKey: ['product', product.id] });
      } catch (err) {
        toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, product.id, product.sku, queryClient]);

  // Discard a never-filled blank draft when leaving (unmount). Fire-and-forget.
  useEffect(() => {
    return () => {
      if (startedEmptyRef.current && isEmptyRef.current) {
        void api.delete(`/api/v1/products/${product.id}`).catch(() => undefined);
      }
    };
  }, [product.id]);

  // Explicit Save — flushes the pending auto-save immediately. Refuses to save a
  // completely empty item (nothing to keep).
  const saveNow = async () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (isEmpty) {
      toast.message('Add a name or some details before saving.');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/products/${product.id}`, buildPayload());
      setSavedAt(new Date());
      queryClient.invalidateQueries({ queryKey: ['product', product.id] });
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Details</CardTitle>
        <div className="flex items-center gap-3">
          <span className="text-xs text-foreground-subtle">
            {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Auto-save on'}
          </span>
          <Button size="sm" onClick={() => void saveNow()} loading={saving} disabled={isEmpty}>
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sku">SKU</Label>
          <Input id="sku" value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <Select value={draft.categoryId} onValueChange={(v) => setDraft({ ...draft, categoryId: v })}>
            <SelectTrigger id="category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="price">Price ({orgCurrency})</Label>
          <Input
            id="price"
            inputMode="decimal"
            value={draft.priceMajor}
            placeholder="0.00"
            onChange={(e) => setDraft({ ...draft, priceMajor: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="compareAt">Compare-at price (optional)</Label>
          <Input
            id="compareAt"
            inputMode="decimal"
            value={draft.compareAtMajor}
            placeholder="0.00"
            onChange={(e) => setDraft({ ...draft, compareAtMajor: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="shortDescription">Short description</Label>
          <Input
            id="shortDescription"
            value={draft.shortDescription}
            placeholder="One-liner that the chatbot can quote"
            onChange={(e) => setDraft({ ...draft, shortDescription: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <MarkdownEditor
            id="description"
            rows={8}
            value={draft.description}
            placeholder="Use the toolbar for bold, italic, headings, lists, and links. Stored as markdown."
            onChange={(next) => setDraft({ ...draft, description: next })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Images --------------------------------------------------------
function ImagesCard({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (vars: { assetId: string; isPrimary: boolean }) =>
      api.post(`/api/v1/products/${product.id}/images`, vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product', product.id] }),
  });
  const detach = useMutation({
    mutationFn: (imageId: string) => api.delete(`/api/v1/products/${product.id}/images/${imageId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product', product.id] }),
  });
  const setPrimary = useMutation({
    mutationFn: (vars: { assetId: string; imageId: string }) =>
      // No dedicated PATCH on images; re-attach with isPrimary toggles. For simplicity
      // here, detach old + attach as primary.
      (async () => {
        await api.delete(`/api/v1/products/${product.id}/images/${vars.imageId}`);
        await api.post(`/api/v1/products/${product.id}/images`, {
          assetId: vars.assetId,
          isPrimary: true,
        });
      })(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product', product.id] }),
  });

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const [i, file] of Array.from(files).entries()) {
        if (!file.type.startsWith('image/')) {
          toast.warning(`Skipped ${file.name}: not an image`);
          continue;
        }
        const { assetId } = await uploadFile(file, 'image');
        await attach.mutateAsync({ assetId, isPrimary: product.images.length === 0 && i === 0 });
      }
      toast.success('Images uploaded');
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'SERVICE_UNAVAILABLE') {
        toast.error('Object storage is not configured. Add Wasabi keys to .env to enable uploads.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Upload failed');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Images</CardTitle>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => fileInput.current?.click()}
          loading={uploading}
        >
          <Upload className="size-4" /> Upload
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </CardHeader>
      <CardContent>
        {product.images.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-border px-6 py-12 text-center text-sm text-foreground-muted transition-colors hover:border-brand-400 hover:bg-brand-50/30"
          >
            <ImageIcon className="mb-2 size-8 text-foreground-subtle" />
            <span>Drop images here or click to upload</span>
            <span className="mt-1 text-xs text-foreground-subtle">JPG, PNG, WEBP up to 10 MB</span>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {product.images.map((img) => (
              <div
                key={img.id}
                className="group relative cursor-zoom-in overflow-hidden rounded-lg border border-border"
                onClick={() => setLightbox(img.url)}
                title="Click to view"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.altText ?? ''} className="aspect-square w-full object-cover" />
                <div className="absolute inset-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/60 via-transparent to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="flex gap-1">
                    {img.isPrimary ? (
                      <Badge variant="default" className="bg-amber-100 text-amber-800">
                        <Star className="mr-1 size-3 fill-current" /> Primary
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPrimary.mutate({ assetId: img.assetId, imageId: img.id });
                        }}
                      >
                        Make primary
                      </Button>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="danger"
                    aria-label="Remove image"
                    onClick={(e) => {
                      e.stopPropagation();
                      detach.mutate(img.id);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
      </CardContent>
    </Card>
  );
}

// ---------- Variants ------------------------------------------------------
function VariantsCard({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const [variants, setVariants] = useState<VariantDraft[]>(
    product.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      options: Object.fromEntries(Object.entries(v.options).map(([k, val]) => [k, String(val)])),
      priceMinor: v.priceMinor,
      stockQuantity: v.stockQuantity,
      isAvailable: v.isAvailable,
    })),
  );
  const [optionKey, setOptionKey] = useState('');
  const [extraOptionKeys, setExtraOptionKeys] = useState<string[]>([]);

  useEffect(() => {
    setVariants(
      product.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        options: Object.fromEntries(Object.entries(v.options).map(([k, val]) => [k, String(val)])),
        priceMinor: v.priceMinor,
        stockQuantity: v.stockQuantity,
        isAvailable: v.isAvailable,
      })),
    );
    setExtraOptionKeys([]);
  }, [product]);

  // Merge keys defined on existing variants with keys added before the first
  // variant exists (stored in extraOptionKeys). Otherwise "Add option" is a
  // no-op until the user also clicks "Add variant", which is unintuitive.
  const optionKeys = Array.from(
    new Set([...variants.flatMap((v) => Object.keys(v.options)), ...extraOptionKeys]),
  );

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/products/${product.id}/variants`, {
        variants: variants.map((v, idx) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          options: v.options,
          priceMinor: v.priceMinor,
          stockQuantity: v.stockQuantity,
          isAvailable: v.isAvailable,
          sortOrder: idx,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', product.id] });
      toast.success('Variants saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const addVariant = () => {
    setVariants((prev) => [
      ...prev,
      {
        sku: `${product.sku}-${prev.length + 1}`,
        name: `Variant ${prev.length + 1}`,
        options: Object.fromEntries(optionKeys.map((k) => [k, ''])),
        priceMinor: null,
        stockQuantity: null,
        isAvailable: true,
      },
    ]);
  };

  const addOptionKey = () => {
    const key = optionKey.trim().toLowerCase();
    if (!key || optionKeys.includes(key)) return;
    setVariants((prev) => prev.map((v) => ({ ...v, options: { ...v.options, [key]: '' } })));
    setExtraOptionKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setOptionKey('');
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Variants</CardTitle>
          <p className="mt-1 text-xs text-foreground-subtle">
            Add options like color or size. Each combination becomes a separate variant.
          </p>
          {/* Scope hint — the bot's catalog block in bot-engine.ts only
              reads variant `name` + `priceMinor` (line 285ish). Other
              option metadata is operator-side state, not part of the
              prompt. Without this hint operators expect colour/size
              attributes to show up in chatbot replies; they don't. */}
          <p className="mt-1 text-[11px] text-foreground-subtle">
            Bot sees <span className="font-medium">name + price</span> only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={optionKey}
            onChange={(e) => setOptionKey(e.target.value)}
            placeholder="e.g. color"
            className="w-32"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addOptionKey();
              }
            }}
          />
          <Button size="sm" variant="secondary" onClick={addOptionKey}>
            <Plus className="size-4" /> Option
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {variants.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-6 py-8 text-center text-sm text-foreground-muted">
            No variants. Add option keys above, then add a variant.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Name</th>
                  {optionKeys.map((k) => (
                    <th key={k} className="px-2 py-2">
                      {k}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right">Price (cents)</th>
                  <th className="px-2 py-2 text-right">Stock</th>
                  {/* Visible header for the delete column. Previously
                      this was an unlabelled w-10 cell that the wider
                      Input cells collapsed past on narrow screens,
                      so the trash button effectively disappeared. */}
                  <th className="w-24 px-2 py-2 text-right">Delete</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1.5">
                      <Input
                        value={v.sku}
                        onChange={(e) =>
                          setVariants((prev) =>
                            prev.map((x, idx) => (idx === i ? { ...x, sku: e.target.value } : x)),
                          )
                        }
                        className="h-8 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={v.name}
                        onChange={(e) =>
                          setVariants((prev) =>
                            prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                        className="h-8"
                      />
                    </td>
                    {optionKeys.map((k) => (
                      <td key={k} className="px-2 py-1.5">
                        <Input
                          value={v.options[k] ?? ''}
                          onChange={(e) =>
                            setVariants((prev) =>
                              prev.map((x, idx) =>
                                idx === i ? { ...x, options: { ...x.options, [k]: e.target.value } } : x,
                              ),
                            )
                          }
                          className="h-8"
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        min={0}
                        value={v.priceMinor ?? ''}
                        onChange={(e) =>
                          setVariants((prev) =>
                            prev.map((x, idx) =>
                              idx === i
                                ? { ...x, priceMinor: e.target.value ? Number(e.target.value) : null }
                                : x,
                            ),
                          )
                        }
                        className="h-8 text-right"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        min={0}
                        value={v.stockQuantity ?? ''}
                        onChange={(e) =>
                          setVariants((prev) =>
                            prev.map((x, idx) =>
                              idx === i
                                ? { ...x, stockQuantity: e.target.value ? Number(e.target.value) : null }
                                : x,
                            ),
                          )
                        }
                        className="h-8 text-right"
                      />
                    </td>
                    <td className="w-24 px-2 py-1.5 text-right">
                      {/* Labelled destructive button. Was previously
                          an icon-only ghost button in an unsized
                          column — operators couldn't see it. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-red-600 hover:bg-red-50 hover:text-red-700"
                        aria-label={`Delete variant ${v.name || v.sku || `#${i + 1}`}`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete variant "${v.name || v.sku || `#${i + 1}`}"? Remember to click "Save variants" afterwards to persist the change.`,
                            )
                          ) {
                            setVariants((prev) => prev.filter((_, idx) => idx !== i));
                          }
                        }}
                      >
                        <Trash2 className="size-4" /> Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <Button variant="secondary" onClick={addVariant}>
            <Plus className="size-4" /> Add variant
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save variants
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
