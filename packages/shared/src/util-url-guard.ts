// SSRF guard for outbound fetches the platform makes on behalf of tenants.
//
// Applies to: connector /test probes, scheduled sync, upload adapters, any
// future integration-style HTTP call. Blocks the usual SSRF targets:
//   - non-http(s) schemes (file://, gopher://, ftp://)
//   - loopback (127.0.0.0/8, ::1)
//   - link-local / cloud metadata (169.254.0.0/16 — AWS/GCP/Azure IMDS)
//   - RFC1918 private space (10/8, 172.16/12, 192.168/16)
//   - IPv6 ULA + link-local
//   - credentials in the URL (user:pass@)
//
// The guard allows public hostnames; upstream DNS resolution still happens
// at fetch time, so tenants that host their endpoint on a public IP hit the
// normal code path. We deliberately do NOT resolve DNS here — doing so
// would race (TOCTOU: resolve now, then fetch may hit a different IP).
// Instead, callers that need DNS-pinning should fetch via an agent that
// re-checks the resolved IP — for v1, refusing obvious literal-IP attacks
// + common hostnames catches the pragmatic threat.

const LITERAL_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

/**
 * Parse + validate an outbound URL. Throws `UrlGuardError` on reject.
 * Returns the parsed URL (so callers can use the sanitised form).
 */
export function assertSafeOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError('Invalid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError(`Scheme ${url.protocol} is not allowed — use http or https.`);
  }
  if (url.username || url.password) {
    throw new UrlGuardError('Credentials in the URL (user:pass@) are not allowed.');
  }

  const host = url.hostname.toLowerCase();

  if (LITERAL_BLOCKED_HOSTNAMES.has(host)) {
    throw new UrlGuardError(`Host ${host} is not allowed.`);
  }
  // *.localhost is explicitly forbidden too (RFC 6761).
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UrlGuardError('Loopback hostnames are not allowed.');
  }

  // H-5 — reject non-dotted-quad numeric host encodings that a resolver may
  // still interpret as an IP (e.g. http://2130706433/ = 127.0.0.1). A real
  // public hostname is never all-digits.
  if (/^\d+$/.test(host)) {
    throw new UrlGuardError(`Numeric host (${host}) is not allowed.`);
  }

  // If hostname is a literal IP, block private ranges. If it's a name, let
  // it through — we're trusting public DNS to resolve it (a TOCTOU-prone
  // model, but pragmatic for v1).
  const v4 = parseIPv4(host);
  if (v4) {
    if (isPrivateIPv4(v4)) {
      throw new UrlGuardError(`Private/loopback IPv4 (${host}) is not allowed.`);
    }
  } else if (isIPv6Literal(host)) {
    // Conservative: any literal IPv6 is rejected. Public IPv6 endpoints
    // must be named (AAAA record), which the DNS path handles.
    throw new UrlGuardError('Literal IPv6 addresses are not allowed — use a hostname.');
  }

  return url;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  // Strip surrounding brackets that only belong on v6 literals.
  if (host.startsWith('[') && host.endsWith(']')) return null;
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return null;
    if (!/^\d+$/.test(p)) return null;
    // Reject octal-ambiguous octets (e.g. 0177 = 127) — a resolver may read the
    // leading zero as octal and reach a private IP the decimal parse missed (H-5).
    if (p.length > 1 && p[0] === '0') return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

function isPrivateIPv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (AWS IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // 224+ multicast / reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isIPv6Literal(host: string): boolean {
  // We're called after URL parsing strips brackets, but some hosts still
  // carry them when the user typed them. Accept both.
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // Any colon-present hostname is IPv6 (the URL class already split off the
  // port, so colons in `hostname` are IPv6 separators).
  return h.includes(':');
}
