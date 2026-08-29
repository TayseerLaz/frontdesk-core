// Envelope encryption for secrets at rest (AES-256-GCM).
//
// WhatsApp access tokens + app secrets were stored in plaintext — a DB read
// (SQL injection, a leaked pg_dump, an insider) exposed the ability to
// send/receive WhatsApp as the client and forge signed inbound webhooks.
// This transparently encrypts those columns via a Prisma client extension.
//
// SAFE-BY-DEFAULT: when SECRET_ENCRYPTION_KEY is unset the helpers are
// pass-throughs and the extension is NOT applied at all — behaviour is
// byte-identical to before. Set the key (+ run the backfill) to activate.
//
// Format: `enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>`.
// decrypt() passes plaintext through unchanged, so encrypted and not-yet-
// backfilled plaintext rows coexist safely during/after rollout.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

const PREFIX = 'enc:v1:';

/**
 * Thrown when a value that IS encrypted (carries the enc:v1: prefix) cannot be
 * decrypted — wrong/missing key, GCM auth-tag mismatch, or corruption. We
 * deliberately do NOT swallow this and return the ciphertext: a ciphertext
 * returned in place of a token gets used as a live credential against Meta /
 * Stripe / an upstream, masking tampering and key-rotation mistakes (F-09).
 */
export class SecretDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretDecryptError';
  }
}

function getKey(): Buffer | null {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).');
  }
  return key;
}

export function secretCryptoEnabled(): boolean {
  return getKey() !== null;
}

export function encryptSecret<T extends string | null | undefined>(plain: T): T {
  if (plain == null) return plain;
  const key = getKey();
  if (!key) return plain; // inert
  if ((plain as string).startsWith(PREFIX)) return plain; // already encrypted
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain as string, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (PREFIX +
    [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')) as T;
}

export function decryptSecret<T extends string | null | undefined>(value: T): T {
  if (value == null) return value;
  if (!(value as string).startsWith(PREFIX)) return value; // plaintext passthrough
  const key = getKey();
  if (!key) {
    // The value is encrypted but no key is configured to read it. That is a
    // hard misconfiguration (key unset, lost, or rotated away) — fail loud
    // rather than hand back ciphertext that would be used as a credential.
    throw new SecretDecryptError('encrypted value present but SECRET_ENCRYPTION_KEY is unset');
  }
  try {
    const [, , ivB64, tagB64, ctB64] = (value as string).split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(ctB64!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return out as T;
  } catch (err) {
    // A prefixed value that fails GCM authentication is tampering, corruption,
    // or a wrong key. Throw — never silently return the raw ciphertext (F-09).
    throw new SecretDecryptError(
      'failed to decrypt secret (auth-tag mismatch, wrong key, or corruption)',
      { cause: err },
    );
  }
}

/**
 * Encrypt a structured secret (object) for storage in a JSON/text column.
 * Returns null for null/undefined input, and a single encrypted string
 * otherwise (the JSON column then holds an opaque `enc:v1:…` string value).
 * Inert (returns the JSON string in plaintext) when no key is configured.
 */
export function encryptJsonSecret(value: unknown): string | null {
  if (value == null) return null;
  return encryptSecret(JSON.stringify(value));
}

/**
 * Inverse of {@link encryptJsonSecret}. Transparently handles three shapes so
 * encrypted + not-yet-backfilled rows coexist during rollout:
 *   • an `enc:v1:…` string  → decrypt, then JSON.parse
 *   • a legacy plaintext object (pre-encryption rows read straight from JSONB)
 *   • a plaintext JSON string
 */
export function decryptJsonSecret<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const plain = decryptSecret(value);
    try {
      return JSON.parse(plain) as T;
    } catch {
      // Not JSON — return as-is so a single odd row can't crash a read.
      return plain as unknown as T;
    }
  }
  // Legacy plaintext object stored directly in the JSONB column.
  return value as T;
}

// Per-model field lists to crypt. Scoped to the highest-value secrets first.
const SECRET_FIELDS = ['accessToken', 'appSecret'] as const;

function encryptArgs(args: unknown): void {
  const a = args as Record<string, unknown> | null;
  if (!a) return;
  for (const slot of ['data', 'create', 'update'] as const) {
    const d = a[slot];
    if (!d) continue;
    const objs = Array.isArray(d) ? d : [d];
    for (const o of objs as Record<string, unknown>[]) {
      for (const f of SECRET_FIELDS) {
        const v = o[f];
        if (typeof v === 'string') o[f] = encryptSecret(v);
        else if (v && typeof v === 'object' && typeof (v as { set?: unknown }).set === 'string') {
          (v as { set: string }).set = encryptSecret((v as { set: string }).set);
        }
      }
    }
  }
}

function decryptResult<R>(result: R): R {
  const apply = (o: unknown) => {
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      for (const f of SECRET_FIELDS) {
        if (typeof rec[f] === 'string') rec[f] = decryptSecret(rec[f] as string);
      }
    }
  };
  if (Array.isArray(result)) result.forEach(apply);
  else apply(result);
  return result;
}

/**
 * Wrap a PrismaClient so `whatsapp_channels.accessToken` + `.appSecret` are
 * transparently encrypted on write and decrypted on read. Returns the client
 * UNCHANGED when no key is configured (inert) — so it's safe to call always.
 */
export function withSecretCrypto(client: PrismaClient): PrismaClient {
  if (!secretCryptoEnabled()) return client;
  return client.$extends({
    query: {
      whatsAppChannel: {
        async $allOperations({ args, query }) {
          encryptArgs(args);
          return decryptResult(await query(args));
        },
      },
    },
  }) as unknown as PrismaClient;
}
