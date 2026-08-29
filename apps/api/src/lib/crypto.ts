import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/** Generate an opaque, URL-safe token. Default 32 bytes ≈ 43 chars base64url. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 a token for at-rest storage (so DB leak alone doesn't grant tokens). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a friendly-but-strong temporary password for admin-provisioned
 * accounts. Output is 16 chars from an alphabet that drops visually
 * confusing pairs (I/1, O/0, l/L, etc.). ~96 bits of entropy.
 *
 * The customer is expected to change it on first login (the welcome email
 * tells them to), so trading a little entropy for typeability is fine.
 */
export function generateTempPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ' + 'abcdefghijkmnpqrstuvwxyz' + '23456789';
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const byte = bytes[i]!;
    // Rejection sample to avoid modulo bias against the alphabet length.
    if (byte < Math.floor(256 / alphabet.length) * alphabet.length) {
      out += alphabet[byte % alphabet.length];
    }
  }
  // Pad in the unlikely event we exhausted the buffer without filling;
  // collisions across rejection-sample loop terminations are negligible.
  while (out.length < length) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
