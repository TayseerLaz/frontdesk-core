import fs from 'node:fs';
import path from 'node:path';

import { useMultiFileAuthState } from '@whiskeysockets/baileys';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Per-grant Baileys credential storage, one directory per grant.
 *
 * Deliberately `useMultiFileAuthState` rather than a hand-written DB-backed
 * SignalKeyStore. The review flagged that store as the highest-risk, hardest-to-test
 * component in the plan (BufferJSON round-tripping, null-means-delete, protobuf
 * rehydration, same-object-instance semantics) for zero benefit at a 2-session cap.
 * The tradeoff we accept: credentials sit on this box's disk, so `purge` must be
 * reliable — see below.
 */

function dirFor(grantId: string): string {
  // grantId is a UUID from our own DB, but never build a path from unvalidated input.
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) throw new Error('invalid grantId');
  return path.join(env.AUTH_DIR, grantId);
}

export async function loadAuth(grantId: string) {
  const dir = dirFor(grantId);
  fs.mkdirSync(dir, { recursive: true });
  return useMultiFileAuthState(dir);
}

/** Does this grant still have credentials on disk? */
export function hasAuth(grantId: string): boolean {
  try {
    const dir = dirFor(grantId);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Destroy a grant's credentials. This is the operation that makes "time-boxed" true, so
 * it returns success/failure honestly instead of swallowing errors — the caller retries
 * until it succeeds and only then stamps authPurgedAt (blocker B1).
 */
export function purgeAuth(grantId: string): boolean {
  try {
    const dir = dirFor(grantId);
    fs.rmSync(dir, { recursive: true, force: true });
    const gone = !fs.existsSync(dir);
    if (gone) logger.info({ grantId }, 'auth purged');
    else logger.error({ grantId }, 'auth purge left the directory behind');
    return gone;
  } catch (err) {
    logger.error({ err, grantId }, 'auth purge failed');
    return false;
  }
}

/** Grant ids that currently have credentials on disk (used by boot reconciliation). */
export function listAuthGrantIds(): string[] {
  try {
    return fs
      .readdirSync(env.AUTH_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
