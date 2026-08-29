// Minimal Shopify Admin REST client for the scrape worker. SSRF-safe (the store
// domain is merchant-supplied) via safeFetch, cursor-paginates through the
// `Link: …rel="next"` header, and pins the API version.
import { safeFetch } from './safe-fetch.js';

const API_VERSION = '2024-10';
const PAGE_LIMIT = 250; // Shopify max per page
const MAX_PAGES = 200; // safety cap (50k records)

export interface ShopifyClientOpts {
  storeDomain: string;
  accessToken: string;
}

function baseHeaders(opts: ShopifyClientOpts): Record<string, string> {
  return { 'X-Shopify-Access-Token': opts.accessToken, Accept: 'application/json' };
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ json: unknown; link: string | null }> {
  const res = await safeFetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Shopify GET ${url} → HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(buf.toString('utf8')) as unknown;
  return { json, link: res.headers.get('link') };
}

/** Parse the next-page URL out of a Shopify `Link` header (rel="next"). */
function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** GET a single Admin API resource (no pagination), returning the named key. */
async function getResource<T>(opts: ShopifyClientOpts, path: string, key: string): Promise<T> {
  const url = `https://${opts.storeDomain}/admin/api/${API_VERSION}/${path}`;
  const { json } = await getJson(url, baseHeaders(opts));
  return (json as Record<string, T>)[key] as T;
}

/** Cursor-paginate a list resource, accumulating json[key] across pages. */
async function getAllPaged<T>(opts: ShopifyClientOpts, resource: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null =
    `https://${opts.storeDomain}/admin/api/${API_VERSION}/${resource}.json?limit=${PAGE_LIMIT}`;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const { json, link }: { json: unknown; link: string | null } = await getJson(
      url,
      baseHeaders(opts),
    );
    const batch = (json as Record<string, T[]>)[key];
    if (Array.isArray(batch)) out.push(...batch);
    url = nextPageUrl(link);
    pages += 1;
  }
  return out;
}

// ----- raw Shopify shapes (only the fields we read) -------------------------
export interface ShopifyShop {
  name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  currency?: string;
  iana_timezone?: string;
  address1?: string;
  city?: string;
  province?: string;
  zip?: string;
  country_name?: string;
}

export interface ShopifyVariant {
  id?: number;
  title?: string;
  sku?: string;
  price?: string;
  inventory_quantity?: number;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

export interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  body_html?: string;
  product_type?: string;
  status?: string;
  // Product-level option names (e.g. [{name:'Size'},{name:'Color'}]) — map onto
  // variant.option1/2/3 to build a labeled options object.
  options?: { name?: string; position?: number }[];
  variants?: ShopifyVariant[];
  images?: { src?: string }[];
}

export interface ShopifyCustomer {
  id?: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string;
  email_marketing_consent?: { state?: string } | null;
  sms_marketing_consent?: { state?: string } | null;
  default_address?: { phone?: string | null } | null;
}

export interface ShopifyPolicy {
  title?: string;
  body?: string;
  handle?: string;
  url?: string;
}

export interface ShopifyPage {
  id?: number;
  title?: string;
  body_html?: string;
}

export interface ShopifyLocation {
  id?: number;
  name?: string;
  address1?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

export const shopifyClient = {
  fetchShop: (o: ShopifyClientOpts) => getResource<ShopifyShop>(o, 'shop.json', 'shop'),
  fetchProducts: (o: ShopifyClientOpts) => getAllPaged<ShopifyProduct>(o, 'products', 'products'),
  fetchCustomers: (o: ShopifyClientOpts) => getAllPaged<ShopifyCustomer>(o, 'customers', 'customers'),
  fetchPolicies: (o: ShopifyClientOpts) => getResource<ShopifyPolicy[]>(o, 'policies.json', 'policies'),
  fetchPages: (o: ShopifyClientOpts) => getAllPaged<ShopifyPage>(o, 'pages', 'pages'),
  fetchLocations: (o: ShopifyClientOpts) => getAllPaged<ShopifyLocation>(o, 'locations', 'locations'),
};
