import fs from 'node:fs';
import path from 'node:path';

import { env } from './env.js';
import { logger } from './logger.js';
import * as platform from './contacts-client.js';
import { ContactsSession } from './contacts-session.js';

/**
 * Drives the WhatsApp contact-sync sessions.
 *
 * Pull model, same as the capture side: the platform is asked what work exists and results are
 * pushed back, so this process needs no inbound connectivity and can stay bound to
 * localhost.
 *
 * Supervised loop rather than a bare setInterval — one uncaught rejection in a naked
 * interval stops the only thing driving the feature, and it stops silently. That exact
 * failure was blocker B3 on the capture side.
 */

const TICK_MS = 5_000;

/** Contact sessions are seconds-long, but they still consume a linked-device slot and a
 *  socket from a shared datacenter IP. Keep the ceiling low and explicit. */
const MAX_CONCURRENT = Number(process.env.WA_CONTACTS_MAX_CONCURRENT ?? 2);

const active = new Map<string, ContactsSession>();

async function tick(): Promise<void> {
  const pending = await platform.fetchPendingSessions();

  // RECONCILE DOWN FIRST. the platform is the system of record for what may run here, so a
  // session it no longer lists must not keep a WhatsApp socket open — whether it was
  // revoked, expired, or the row was removed. Starting only what is authorised is half
  // the job; the half that gets forgotten is stopping what no longer is.
  //
  // This is not hypothetical: the capture pool on this box was found holding an unpaired
  // session for four days because nothing re-derived "should this still exist?". Without
  // this loop a contacts session would likewise survive until its own deadline.
  const authorised = new Set(pending.map((p) => p.sessionId));
  for (const [sessionId, session] of [...active.entries()]) {
    if (authorised.has(sessionId)) continue;
    logger.info({ sessionId }, 'session no longer authorised — tearing down');
    // finish(null) is the clean path: log out, release the device slot, delete creds.
    // No 'ended' report — the platform already stopped listing it, so it knows.
    await session.finish(null).catch((err) => logger.error({ err, sessionId }, 'teardown failed'));
    active.delete(sessionId);
  }

  for (const p of pending) {
    if (active.has(p.sessionId)) continue;
    if (active.size >= MAX_CONCURRENT) {
      logger.warn({ waiting: pending.length, active: active.size }, 'contacts pool at capacity');
      break;
    }

    const session = new ContactsSession({
      sessionId: p.sessionId,
      expiresAt: new Date(p.expiresAt),
      onDone: (id) => active.delete(id),
    });
    active.set(p.sessionId, session);
    logger.info({ sessionId: p.sessionId }, 'starting contacts session');

    // Per-session try/catch: one tenant's bad pairing must not stop the loop for
    // everyone else.
    try {
      await session.start();
    } catch (err) {
      logger.error({ err, sessionId: p.sessionId }, 'contacts session failed to start');
      await session.finish('could not start').catch(() => {});
      active.delete(p.sessionId);
    }
  }
}

export function startContactsPool(): void {
  if (!env.CONTACTS_SECRET) {
    logger.info('WA_CONTACTS_SECRET unset — WhatsApp contact sync disabled');
    return;
  }

  // Purge every contacts credential on disk before starting.
  //
  // A contacts session lives for seconds and is NEVER resumed — the whole design is
  // connect, harvest, log out, delete. So any credential still here at boot belongs to a
  // session the process died holding, and it is an orphan by definition. A restart kills
  // the process before finish() can run, which is precisely how one survived the deploy
  // that added the reconcile loop.
  //
  // Deleting unconditionally is safe here in a way it would not be for capture: there is
  // no long-lived session whose keys we might need again.
  const contactsDir = path.join(env.AUTH_DIR, 'contacts');
  try {
    const orphans = fs.existsSync(contactsDir) ? fs.readdirSync(contactsDir) : [];
    for (const id of orphans) {
      fs.rmSync(path.join(contactsDir, id), { recursive: true, force: true });
      logger.info({ sessionId: id }, 'purged orphaned contacts credentials at boot');
    }
  } catch (err) {
    logger.error({ err }, 'failed to purge orphaned contacts credentials');
  }

  logger.info({ max: MAX_CONCURRENT }, 'WhatsApp contact sync enabled');

  void (async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, 'contacts tick failed');
      }
      await new Promise((r) => setTimeout(r, TICK_MS).unref());
    }
  })();
}

export function activeContactsCount(): number {
  return active.size;
}
