// Sprint 4 — WAF readiness. Resolves the TRUST_PROXY env value into the
// shape `fastify` expects on bootstrap (boolean | string), and exposes the
// Cloudflare IP-range preset.
//
// Why this matters: a careless `trustProxy: true` paired with public
// internet exposure lets any caller spoof `X-Forwarded-For`, bypassing
// IP-based rate limits. The presets here narrow the trust window to the
// upstream that's actually in front of the API.
//
// References:
//   • https://www.cloudflare.com/ips/   (canonical Cloudflare prefixes)
//   • https://fastify.dev/docs/latest/Reference/Server/#trustproxy

import { env } from './env.js';

// Last refreshed 2026-05-26. Cloudflare publishes these on a stable URL
// and updates them rarely; mirror them locally so the API can boot
// without an outbound DNS/HTTP call. Refresh quarterly when rotating
// secrets per RUNBOOK.md.
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const LOOPBACK_AND_LAN = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
];

export const CLOUDFLARE_RANGES = [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6];

/** Resolve the TRUST_PROXY env value into a fastify `trustProxy` option. */
export function resolveTrustProxy(): boolean | string {
  const raw = env.TRUST_PROXY.trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'cloudflare') {
    return [...CLOUDFLARE_RANGES, ...LOOPBACK_AND_LAN].join(',');
  }
  // Treat anything else as a literal CIDR list, comma-separated.
  return raw;
}

/** True when the env opts in to honouring CF-Connecting-IP for req.ip. */
export function trustCfConnectingIp(): boolean {
  return env.TRUST_CF_CONNECTING_IP === true;
}
