// DNS-resolving SSRF guard — closes the DNS-rebinding gap that the literal-IP
// checks in util-url-guard.ts cannot (F-05).
//
// `assertSafeOutboundUrl` only blocks URLs whose *hostname is already a
// private literal IP*. An attacker controls DNS for their own hostname, so
// `http://evil.example/` can pass that check and then resolve to
// 169.254.169.254 (cloud metadata) or 127.0.0.1. The defence is to resolve
// the name ourselves, reject if ANY resolved address is private/loopback/
// link-local, and PIN the connection to the validated address so the value
// can't change between our check and the actual connect (TOCTOU rebinding).
//
// This module imports `node:dns` and is therefore kept OUT of the package's
// main entrypoint (`@platform/shared`) — it is only reachable via the
// `@platform/shared/ssrf` subpath, so the web (browser) bundle never pulls it.
import { lookup as dnsLookup } from 'node:dns';

/** True if a resolved IP address must never be the target of an outbound fetch. */
export function isForbiddenAddress(address: string, family: number): boolean {
  const addr = address.toLowerCase();
  if (family === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    return isForbiddenIPv4(addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr);
  }
  // IPv6
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // fc00::/7 ULA
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify the embedded v4.
  if (addr.startsWith('::ffff:') && addr.includes('.')) {
    return isForbiddenIPv4(addr.slice(addr.lastIndexOf(':') + 1));
  }
  return false;
}

function isForbiddenIPv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → refuse
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export class SsrfRebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRebindError';
  }
}

/**
 * A `net.LookupFunction`-shaped resolver for undici's `Agent({ connect: { lookup } })`.
 * Resolves every address for the hostname, refuses if ANY is private, and
 * connects to a validated address — so undici cannot be rebound to a private
 * host after validation.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: unknown,
  // net.LookupFunction is overloaded: with `{ all: true }` the callback expects
  // an ARRAY of {address, family}; otherwise a single (address, family). undici
  // calls us in `all` mode on newer versions, so we must honour both shapes or
  // the connection fails with ERR_INVALID_IP_ADDRESS.
  callback: (
    err: Error | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
): void {
  const wantsAll = !!(options && typeof options === 'object' && (options as { all?: boolean }).all);
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (!addresses.length) {
      return callback(new SsrfRebindError(`${hostname} did not resolve to any address.`), '', 0);
    }
    const forbidden = addresses.find((a) => isForbiddenAddress(a.address, a.family));
    if (forbidden) {
      return callback(
        new SsrfRebindError(
          `${hostname} resolves to a blocked address (${forbidden.address}) — refusing (SSRF).`,
        ),
        '',
        0,
      );
    }
    if (wantsAll) {
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    }
  });
}
