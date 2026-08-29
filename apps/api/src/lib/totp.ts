// RFC 6238 TOTP, implemented in ~80 lines so we don't pull a dep.
// Defaults: SHA-1, 30s step, 6-digit code, ±1 step skew on verify.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;

// RFC 4648 base32 — IA5 alphabet, no padding.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  const cleaned = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes of cryptographic randomness, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secretBase32: string, counter: number): string {
  const buf = Buffer.alloc(8);
  // big-endian 64-bit counter
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter & 0xffff_ffff, 4);
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Return the matched counter step for a valid 6-digit code (±1 step skew), or
 * null if it doesn't match. Callers that need replay protection (L-6) persist
 * the highest matched step per user and reject a code whose step was already
 * consumed — otherwise an observed code is reusable for up to ~90s.
 */
export function matchTotpStep(secretBase32: string, code: string): number | null {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return null;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const c of [counter - 1, counter, counter + 1]) {
    const expected = hotp(secretBase32, c);
    // timingSafeEqual requires equal-length buffers; both are 6 ASCII chars.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))) return c;
  }
  return null;
}

/** Verify a 6-digit code against a base32 secret with ±1 step skew. */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  return matchTotpStep(secretBase32, code) !== null;
}

/** Build an `otpauth://totp/...` URI for QR provisioning. */
export function buildOtpAuthUri(args: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}): string {
  const label = `${args.issuer}:${args.accountName}`;
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * 10 single-use recovery codes, each 16 base32 chars = 80 bits of unbiased
 * entropy (from randomBytes). Wide enough that a leaked SHA-256 hash of a code
 * is not brute-forceable — unlike the previous ~40-bit codes, which also had a
 * modulo bias from `b % ALPHA.length` (L-2). Existing codes keep verifying: the
 * hashing (sha256 of the uppercased code) is unchanged, so this only affects
 * newly generated batches.
 */
export function generateRecoveryCodes(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    // 10 random bytes = 80 bits → exactly 16 base32 chars (5 bits/char).
    out.push(base32Encode(randomBytes(10)));
  }
  return out;
}
