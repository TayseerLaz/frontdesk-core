// F10 — website product-feed connector mapping (roadmap 2026-08-26).
//
// Pure logic shared by the sync worker (applies the mapping), the API's
// preview endpoint, and the web wizard (suggests + previews it). NO env/db
// imports — runs in the pure HARD gate.
//
// Two mapping shapes live in ApiConnector.columnMapping:
//   • legacy v1: flat { sourceKey: targetKey } rename — untouched, still works
//   • v2: { __v: 2, arrayPath, fields: { targetField: sourceDotPath },
//           priceUnit } — nested paths, array extraction, price conversion.
// The worker is the only authority on final validation (shared-upsert zod);
// `previewProblems` here is a UX pre-check for the wizard, nothing more.

export interface MappingV2 {
  __v: 2;
  /** Dot-path to the record array inside the response ('' / null = auto). */
  arrayPath?: string | null;
  /** targetField → source dot-path (e.g. { priceMinor: 'price.amount' }). */
  fields: Record<string, string>;
  /** 'major' = feed prices are 12.5-style units → ×100 into minor units. */
  priceUnit?: 'major' | 'minor';
}

export function isMappingV2(raw: unknown): raw is MappingV2 {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as { __v?: unknown }).__v === 2 &&
    typeof (raw as { fields?: unknown }).fields === 'object'
  );
}

/** Dot-path getter; numeric segments index arrays ("images.0.url"). */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

const COMMON_ARRAY_KEYS = ['data', 'products', 'items', 'results', 'records', 'rows', 'result'];

/**
 * Pull the record array out of a response. An explicit arrayPath wins; with
 * none, fall back to: root array → common wrapper keys (one level, then two)
 * → the first array-of-objects value found.
 */
export function extractRecords(json: unknown, arrayPath?: string | null): Record<string, unknown>[] {
  const asRecords = (v: unknown): Record<string, unknown>[] | null =>
    Array.isArray(v) && v.every((x) => x != null && typeof x === 'object' && !Array.isArray(x))
      ? (v as Record<string, unknown>[])
      : null;
  if (arrayPath) return asRecords(getPath(json, arrayPath)) ?? [];
  const root = asRecords(json);
  if (root) return root;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const k of COMMON_ARRAY_KEYS) {
      const hit = asRecords(obj[k]);
      if (hit) return hit;
      // one level deeper: { result: { items: [...] } }
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        for (const k2 of COMMON_ARRAY_KEYS) {
          const deep = asRecords((obj[k] as Record<string, unknown>)[k2]);
          if (deep) return deep;
        }
      }
    }
    for (const v of Object.values(obj)) {
      const hit = asRecords(v);
      if (hit) return hit;
    }
  }
  return [];
}

/** Candidate array paths for the wizard's picker, most likely first. */
export function suggestArrayPaths(json: unknown): string[] {
  const out: string[] = [];
  const asArrayOfObjects = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0 && v.every((x) => x != null && typeof x === 'object' && !Array.isArray(x));
  if (asArrayOfObjects(json)) out.push('');
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (asArrayOfObjects(v)) out.push(k);
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (asArrayOfObjects(v2)) out.push(`${k}.${k2}`);
        }
      }
    }
  }
  return out.slice(0, 10);
}

/**
 * Flatten one sample record into selectable source paths for the wizard's
 * dropdowns. Arrays surface as the bare path (whole array) AND `.0`-indexed
 * children so both "images" and "images.0.url" are pickable.
 */
export function listLeafPaths(record: Record<string, unknown>, maxDepth = 3, cap = 120): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= cap) return;
    if (v == null || typeof v !== 'object') {
      if (path) out.push(path);
      return;
    }
    if (Array.isArray(v)) {
      if (path) out.push(path); // the whole array is a valid pick (images)
      if (depth < maxDepth && v.length > 0) walk(v[0], path ? `${path}.0` : '0', depth + 1);
      return;
    }
    if (depth >= maxDepth) {
      if (path) out.push(path);
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(record, '', 0);
  return out.slice(0, cap);
}

// Wizard auto-mapping: first source path whose LAST segment matches a
// heuristic for the target field. Deliberately dumb and transparent — the
// operator sees and can change every guess.
const FIELD_HINTS: Record<string, RegExp> = {
  name: /^(name|title|product_?name|label)$/i,
  sku: /^(sku|id|code|product_?id|reference|ref)$/i,
  priceMinor: /^(price|amount|unit_?price|sale_?price|price_?minor)$/i,
  currency: /^(currency|currency_?code)$/i,
  shortDescription: /^(short_?description|summary|subtitle|excerpt)$/i,
  description: /^(description|body|details|content|body_?html)$/i,
  stockQuantity: /^(stock|quantity|qty|inventory|stock_?quantity|inventory_?quantity)$/i,
  categorySlug: /^(category|category_?slug|category_?name|collection|type)$/i,
  imageUrls: /^(images?|image_?urls?|pictures?|photos?|thumbnails?)$/i,
  isAvailable: /^(available|is_?available|in_?stock|active|is_?active|published)$/i,
};

export function suggestFieldMapping(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, re] of Object.entries(FIELD_HINTS)) {
    // Prefer the shallowest matching path.
    const match = [...paths]
      .sort((a, b) => a.split('.').length - b.split('.').length)
      .find((p) => {
        const segs = p.split('.');
        // For arrays we want the bare array path, not its .0 child.
        const last = segs[segs.length - 1] === '0' ? segs[segs.length - 2] : segs[segs.length - 1];
        return !!last && re.test(last);
      });
    if (match) {
      const segs = match.split('.');
      out[field] = segs[segs.length - 1] === '0' ? segs.slice(0, -1).join('.') : match;
    }
  }
  return out;
}

// Image sources come in every shape: "a.jpg, b.jpg", ["a.jpg"], or
// [{url|src|link|href: ...}]. Normalize to the comma-separated string the
// import worker's image attach already understands.
function normalizeImageUrls(v: unknown): string | undefined {
  const fromItem = (item: unknown): string | null => {
    if (typeof item === 'string') return item.trim() || null;
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      for (const k of ['url', 'src', 'link', 'href']) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
      }
    }
    return null;
  };
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) {
    const urls = v.map(fromItem).filter((u): u is string => !!u);
    return urls.length ? urls.join(', ') : undefined;
  }
  const single = fromItem(v);
  return single ?? undefined;
}

const PRICE_FIELDS = new Set(['priceMinor', 'basePriceMinor']);

/** Apply a v2 mapping to one raw feed record → shared-upsert-shaped object. */
export function applyMappingV2(
  record: Record<string, unknown>,
  mapping: MappingV2,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const priceUnit = mapping.priceUnit ?? 'major';
  for (const [target, sourcePath] of Object.entries(mapping.fields)) {
    if (!sourcePath) continue;
    let v = getPath(record, sourcePath);
    if (v === undefined || v === null || v === '') continue;
    if (target === 'imageUrls') {
      v = normalizeImageUrls(v);
      if (v === undefined) continue;
    } else if (PRICE_FIELDS.has(target)) {
      // "call us" strips to '' and Number('') is 0 — an empty cleaned string
      // must DROP the field, never silently price the product at zero.
      const cleaned = typeof v === 'number' ? v : String(v).replace(/[^\d.-]/g, '');
      if (cleaned === '') continue;
      const n = typeof cleaned === 'number' ? cleaned : Number(cleaned);
      if (!Number.isFinite(n)) continue;
      v = Math.round(priceUnit === 'major' ? n * 100 : n);
    }
    out[target] = v;
  }
  return out;
}

/**
 * Wizard-side pre-check ONLY (the worker's zod schemas stay the authority):
 * flags the mistakes an operator can fix in the mapper before saving.
 */
export function previewProblems(mapped: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!mapped.name || String(mapped.name).trim() === '') problems.push('Name is missing');
  if (!mapped.sku || String(mapped.sku).trim() === '') problems.push('SKU / unique id is missing');
  if (mapped.priceMinor === undefined) problems.push('Price is missing');
  else if (typeof mapped.priceMinor !== 'number' || !Number.isInteger(mapped.priceMinor))
    problems.push('Price did not parse as a number');
  if (mapped.currency !== undefined && String(mapped.currency).length !== 3)
    problems.push('Currency must be a 3-letter code (e.g. USD)');
  return problems;
}
