// SSRF-safe outbound fetch for tenant-triggered requests (connector test
// probes, Shopify verify/scrape, template/media pulls). Closes the two SSRF
// holes the bare `fetch(url, { redirect: 'follow' })` pattern leaves open:
//
//   1. DNS rebinding — a public hostname that resolves to a private IP at
//      connect time. Closed by the pinning lookup (`ssrfSafeLookup`): it
//      resolves every address, refuses if ANY is private, and pins to a
//      validated address.
//   2. Redirect-to-literal-IP (H-6) — a `302 → http://169.254.169.254/` (or any
//      RFC1918 literal). undici skips DNS for a literal-IP host, so the lookup
//      hook never runs and the previous auto-follow fetch connected straight to
//      the private IP. We now validate the target at CONNECT time, which also
//      covers every redirect hop (undici reuses this dispatcher when following
//      3xx), rejecting a literal private/loopback/link-local IP before we open
//      the socket.
import { isIP } from 'node:net';

import { assertSafeOutboundUrl } from '@platform/shared';
import { isForbiddenAddress, ssrfSafeLookup } from '@platform/shared/ssrf';
import { Agent, buildConnector } from 'undici';

let dispatcher: Agent | null = null;

/** Lazily-built undici Agent that refuses private/loopback IPs — hostnames via
 *  the pinning lookup, literal IPs (incl. redirect targets) at connect time. */
export function ssrfSafeDispatcher(): Agent {
  if (!dispatcher) {
    const base = buildConnector({ lookup: ssrfSafeLookup });
    dispatcher = new Agent({
      connect(opts, cb) {
        const fam = isIP(opts.hostname);
        if (fam !== 0 && isForbiddenAddress(opts.hostname, fam)) {
          cb(new Error(`Blocked private/literal IP: ${opts.hostname}`), null);
          return;
        }
        base(opts, cb);
      },
    });
  }
  return dispatcher;
}

/**
 * Drop-in `fetch` for outbound calls to tenant-supplied URLs. Validates the URL
 * up front (throws `UrlGuardError`) and routes every connection — the initial
 * request and each redirect hop — through the SSRF-safe dispatcher.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  assertSafeOutboundUrl(url);
  return fetch(url, { ...init, dispatcher: ssrfSafeDispatcher() } as RequestInit & {
    dispatcher: Agent;
  });
}
