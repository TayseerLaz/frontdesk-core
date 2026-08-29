// SSRF-safe outbound fetch for worker jobs (import image pulls, crawl thumbnail
// downloads, outbound webhook delivery). Closes the two SSRF holes the bare
// `fetch(url, { redirect: 'follow' })` pattern leaves open:
//
//   1. DNS rebinding — a public hostname that resolves to a private IP at
//      connect time. Closed by the pinning dispatcher (`ssrfSafeLookup`):
//      it resolves every address, refuses if ANY is private, and pins the
//      connection to a validated address.
//   2. Redirect-to-private — a public URL that 3xx-redirects to
//      `http://169.254.169.254/...` or an RFC1918 host. The pinning
//      dispatcher does NOT catch a *literal-IP* redirect target (undici skips
//      DNS for a literal IP, so the lookup hook never runs), so we follow
//      redirects MANUALLY and re-run the synchronous guard on every hop.
//
// Use this instead of the global `fetch` anywhere the worker fetches a
// tenant- or third-party-supplied URL.
import { lookup as dnsLookup } from 'node:dns';
import type { Readable } from 'node:stream';

import { assertSafeOutboundUrl, UrlGuardError } from '@platform/shared';
import { isForbiddenAddress, ssrfSafeLookup } from '@platform/shared/ssrf';
import { Agent, request as undiciRequest } from 'undici';

let ssrfDispatcher: Agent | null = null;

/** Lazily-built undici Agent that refuses to connect to private/loopback IPs. */
export function getSsrfDispatcher(): Agent {
  if (!ssrfDispatcher) ssrfDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  return ssrfDispatcher;
}

const MAX_REDIRECTS = 5;

export interface SafeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  /** Node Readable (undici body). Async-iterable; also exposes `.arrayBuffer()`. */
  body: Readable & { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * SSRF-safe outbound fetch. Validates the URL and every redirect hop with the
 * synchronous guard (catches literal private IPs), connects through the
 * IP-pinning dispatcher (catches hostname→private DNS rebinding), and follows
 * redirects manually so each `Location` is re-validated before we connect.
 *
 * Throws `UrlGuardError` if the URL — or any redirect target — is blocked.
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeResponse> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertSafeOutboundUrl(current); // throws UrlGuardError on private/literal-IP/bad-scheme
    // undici's `request` does NOT auto-follow redirects (no maxRedirections),
    // so we see each 3xx and re-validate the Location before connecting.
    const res = await undiciRequest(current, {
      method: init.method ?? 'GET',
      headers: init.headers,
      signal: init.signal,
      dispatcher: getSsrfDispatcher(),
    });
    const status = res.statusCode;
    if (status >= 300 && status < 400) {
      const loc = res.headers['location'];
      const locStr = Array.isArray(loc) ? loc[0] : loc;
      if (locStr) {
        res.body.resume(); // drain so the socket can be reused
        current = new URL(locStr, current).toString();
        continue;
      }
    }
    const headerGet = (name: string): string | null => {
      const v = res.headers[name.toLowerCase()];
      if (v == null) return null;
      return Array.isArray(v) ? (v[0] ?? null) : String(v);
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: headerGet },
      body: res.body as Readable & { arrayBuffer(): Promise<ArrayBuffer> },
      arrayBuffer: () => res.body.arrayBuffer(),
    };
  }
  throw new UrlGuardError('Too many redirects (SSRF-safe fetch).');
}

/**
 * Pre-flight SSRF check for outbound navigations we can't route through the
 * pinning dispatcher — notably Playwright/Chromium `page.goto`, where the
 * browser does its own DNS. Runs the synchronous guard, then resolves the
 * hostname and refuses if ANY address is private/loopback/link-local.
 *
 * This narrows (does not fully eliminate) the rebinding window for the browser
 * — a determined attacker can still rebind between this resolve and Chromium's
 * own resolve; full closure requires a forward proxy / `--host-resolver-rules`.
 * Throws `UrlGuardError` on a blocked target.
 */
export async function assertUrlResolvesPublic(rawUrl: string): Promise<void> {
  const url = assertSafeOutboundUrl(rawUrl); // scheme / credentials / literal-IP guard
  // A literal-IP host that passed the guard above is already public — no DNS.
  await new Promise<void>((resolve, reject) => {
    dnsLookup(url.hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(new UrlGuardError(`DNS resolution failed for ${url.hostname}.`));
      if (!addresses.length) {
        return reject(new UrlGuardError(`${url.hostname} did not resolve to any address.`));
      }
      const bad = addresses.find((a) => isForbiddenAddress(a.address, a.family));
      if (bad) {
        return reject(
          new UrlGuardError(`${url.hostname} resolves to a blocked address (${bad.address}) — SSRF.`),
        );
      }
      resolve();
    });
  });
}
