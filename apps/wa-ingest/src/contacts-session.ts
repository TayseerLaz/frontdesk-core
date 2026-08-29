import fs from 'node:fs';
import path from 'node:path';

import baileysPkg, {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

import pino from 'pino';

import { env } from './env.js';
import { logger } from './logger.js';
import * as hader from './contacts-client.js';

/**
 * The logger handed to Baileys itself.
 *
 * session.ts declares its own equivalent with NO redact config, which the 2026-08-03
 * review flagged: the library is free to log whatever it likes at debug level. This one
 * is 'warn' AND redacted, so a future Baileys version that starts logging payloads cannot
 * put third-party contact data into journald through this path.
 */
const waLogger = pino({
  level: 'warn',
  redact: {
    paths: ['body', '*.body', 'text', '*.text', 'message', '*.message', 'notify', '*.notify'],
    censor: '[redacted]',
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

// Baileys ships CJS; the callable default lands on .default under ESM interop depending
// on bundler and Node version. Resolve it once rather than calling the namespace object.
const makeWASocket =
  (baileysPkg as unknown as { default?: unknown }).default ?? (baileysPkg as unknown);

/**
 * A WhatsApp session that exists ONLY to read the account's contact list.
 *
 * The defining property, and the reason this is a separate file rather than a mode on
 * SalesScanSession: **no message handler is ever registered.** Not disabled, not filtered
 * — absent. `messages.upsert` is never subscribed to, so the capability to read a
 * customer's messages is never created, and no future edit to a shared filter can
 * accidentally grant it. History sync is refused for the same reason.
 *
 * Lifetime is seconds, not days: connect, take the contact list, push it, log out, delete
 * the credentials. Logging out matters twice over — it releases one of the tenant's four
 * linked-device slots, and it means a stolen disk yields nothing.
 */

/**
 * Baileys' DisconnectReason.restartRequired. Hard-coded rather than imported because the
 * enum's export shape shifts between minors and this value must not silently become
 * undefined — that is the difference between pairing working and pairing never working.
 */
const RESTART_REQUIRED = 515;
/** One handshake restart is normal; more than a couple means something else is wrong. */
const MAX_RESTARTS = 2;

/**
 * Quiet period between contact bursts. Armed ONLY after the first batch arrives — arming
 * it on connection-open (as this first did) gave up six seconds after linking, while
 * WhatsApp's initial sync had not even started. Baileys' own init queries do not time out
 * for 60s, so the socket was being destroyed long before the contacts could land, and the
 * tenant saw "no contacts received" on a link that had worked.
 */
const SETTLE_MS = 8_000;

/** How long to wait for the FIRST contact after linking, before giving up. */
const INITIAL_WAIT_MS = 120_000;

/** Even if contacts keep trickling, stop here and take what we have. */
const MAX_HARVEST_MS = 180_000;

export interface ContactsSessionDeps {
  sessionId: string;
  expiresAt: Date;
  onDone: (sessionId: string) => void;
}

interface Harvested {
  phone: string;
  name: string | null;
}

export class ContactsSession {
  private sock: ReturnType<typeof Object> | null = null;
  private readonly contacts = new Map<string, Harvested>();
  private settleTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private finished = false;
  private linkedPhone: string | null = null;
  /** Handshake restarts consumed. See the 515 branch in the close handler. */
  private restarts = 0;

  constructor(private readonly deps: ContactsSessionDeps) {}

  private get dir(): string {
    // Never build a path from unvalidated input, even though this is our own UUID.
    if (!/^[0-9a-f-]{36}$/i.test(this.deps.sessionId)) throw new Error('invalid sessionId');
    return path.join(env.AUTH_DIR, 'contacts', this.deps.sessionId);
  }

  async start(): Promise<void> {
    const msLeft = this.deps.expiresAt.getTime() - Date.now();
    if (msLeft <= 0) {
      await this.finish('expired before start');
      return;
    }
    // Hard stop at the session deadline regardless of what the socket is doing. Set once,
    // not per-connect, so a handshake restart cannot extend the window.
    this.deadlineTimer = setTimeout(() => void this.finish('deadline reached'), msLeft);
    this.deadlineTimer.unref();

    await this.connect();
  }

  /**
   * Build the socket. Called again after a 515 restart, which is a NORMAL step in
   * pairing, not a failure — see the close handler.
   */
  private async connect(): Promise<void> {
    if (this.finished) return;

    fs.mkdirSync(this.dir, { recursive: true });
    const auth = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion();

    const config = {
      version,
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, waLogger),
      },
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['Hader Contacts', 'Chrome', '120.0.0'],
      // No history, ever. We want the address book, not the conversations.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false, // stay invisible; this must not look like the user online
      shouldIgnoreJid: (jid: string) =>
        isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid),
      getMessage: async () => undefined,
    };
    // Cast: our predicates and browser tuple do not line up with Baileys' exported
    // SocketConfig, whose shape shifts between minors.
    this.sock = (makeWASocket as (c: unknown) => unknown)(config) as ReturnType<typeof Object>;
    const sock = this.sock as unknown as {
      ev: { on: (e: string, cb: (...a: unknown[]) => void) => void };
      user?: { id?: string };
      logout: () => Promise<void>;
      end?: (e?: Error) => void;
    };

    sock.ev.on('creds.update', () => void auth.saveCreds());

    sock.ev.on('connection.update', (u: unknown) => {
      const update = u as {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      };

      if (update.qr) {
        // Push the RAW pairing payload (~200 chars), not a rendered PNG. The portal
        // already renders QR codes client-side for the other two flows, so shipping a
        // multi-kilobyte base64 data URL through the API and into a DB column bought
        // nothing — and blew the 4096-char body cap, which is how this first failed.
        void hader
          .pushQr(this.deps.sessionId, update.qr)
          .catch((err) => hader.logContactsFailure(err, 'pushQr'));
      }

      if (update.connection === 'open') {
        this.linkedPhone = (sock.user?.id ?? '').split(':')[0]?.split('@')[0] ?? null;
        logger.info(
          { sessionId: this.deps.sessionId },
          'linked — waiting for WhatsApp to send the contact list',
        );
        // Clearing the QR is what lets the desktop say "connected" honestly.
        void hader
          .pushQr(this.deps.sessionId, null, this.linkedPhone)
          .catch((err) => hader.logContactsFailure(err, 'pushQr(open)'));

        // Wait for the FIRST batch on a long timer. The settle timer that decides we are
        // DONE is armed by absorb(), once contacts actually start arriving.
        if (!this.initialTimer) {
          this.initialTimer = setTimeout(() => void this.harvest(), INITIAL_WAIT_MS);
          this.initialTimer.unref();
        }
        if (!this.hardTimer) {
          this.hardTimer = setTimeout(() => void this.harvest(), MAX_HARVEST_MS);
          this.hardTimer.unref();
        }
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;

        // 515 = restartRequired, and it is what a SUCCESSFUL scan looks like. WhatsApp
        // completes the pairing handshake, saves credentials, then closes the stream and
        // expects the client to reconnect with those credentials. Treating it as a
        // failure — as this did — tears the session down at the exact moment it worked,
        // which is what the tenant saw as "connection closed (515)" right after scanning.
        //
        // Reconnect once. Bounded, because an unbounded retry from a shared datacenter IP
        // is the ban signal this whole design avoids.
        if (code === RESTART_REQUIRED && this.restarts < MAX_RESTARTS) {
          this.restarts += 1;
          logger.info(
            { sessionId: this.deps.sessionId, attempt: this.restarts },
            'pairing handshake complete — reconnecting with saved credentials',
          );
          void this.connect().catch((err) => {
            logger.error({ err, sessionId: this.deps.sessionId }, 'reconnect failed');
            void this.finish('could not complete pairing');
          });
          return;
        }

        // Anything else with nothing harvested is terminal: this is a one-shot pairing and
        // retrying would re-show a QR nobody asked for.
        if (this.contacts.size === 0) {
          void this.finish(`connection closed (${code ?? 'unknown'})`);
        } else {
          void this.harvest();
        }
      }
    });

    // THE ONLY DATA SUBSCRIPTIONS. Note what is absent: messages.upsert.
    // Counts only in the logs — never a name or a number.
    sock.ev.on('contacts.upsert', (rows: unknown) => {
      logger.info(
        { sessionId: this.deps.sessionId, n: Array.isArray(rows) ? rows.length : 0 },
        'contacts.upsert',
      );
      this.absorb(rows);
    });
    sock.ev.on('contacts.update', (rows: unknown) => {
      logger.info(
        { sessionId: this.deps.sessionId, n: Array.isArray(rows) ? rows.length : 0 },
        'contacts.update',
      );
      this.absorb(rows);
    });
    sock.ev.on('messaging-history.set', (payload: unknown) => {
      const p = payload as { contacts?: unknown[]; chats?: unknown[]; syncType?: unknown };
      logger.info(
        {
          sessionId: this.deps.sessionId,
          contacts: p?.contacts?.length ?? 0,
          chats: p?.chats?.length ?? 0,
          syncType: p?.syncType ?? null,
        },
        'messaging-history.set',
      );
      if (p?.contacts) this.absorb(p.contacts);
    });
  }

  /** Pull individual contacts out of whatever shape Baileys handed us. */
  private absorb(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    let added = 0;

    for (const raw of rows) {
      const c = raw as {
        id?: string;
        name?: string;
        notify?: string;
        verifiedName?: string;
      };
      const jid = c?.id;
      if (typeof jid !== 'string' || !jid) continue;

      // Individuals only. Groups, broadcasts, newsletters and status are not people, and
      // a group's subject is third-party free text we have no business storing here.
      if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid))
        continue;
      if (!jid.endsWith('@s.whatsapp.net')) continue;

      const phone = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? '';
      if (phone.length < 8 || phone.length > 15) continue;
      // The tenant's own number is not a customer contact.
      if (this.linkedPhone && phone === this.linkedPhone) continue;

      const name = (c.name || c.verifiedName || c.notify || '').trim() || null;
      const existing = this.contacts.get(phone);
      if (existing) {
        if (!existing.name && name) existing.name = name;
        continue;
      }
      this.contacts.set(phone, { phone, name });
      added += 1;
    }

    // Counts only — never a name, which is third-party personal data.
    if (added > 0) {
      logger.info({ sessionId: this.deps.sessionId, added, total: this.contacts.size }, 'contacts absorbed');
      this.armHarvest();
    }
  }

  /**
   * Harvest once contacts stop arriving. WhatsApp delivers the address book in bursts
   * after pairing, so a fixed sleep either truncates a big account or wastes a linked
   * device slot on a small one; a settle timer that resets on each burst does neither.
   */
  private armHarvest(): void {
    if (this.finished) return;
    // Contacts are flowing, so the initial-wait deadline no longer applies.
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => void this.harvest(), SETTLE_MS);
    this.settleTimer.unref();
  }

  private async harvest(): Promise<void> {
    if (this.finished) return;
    const list = [...this.contacts.values()];
    if (list.length === 0) {
      await this.finish('no contacts received');
      return;
    }
    try {
      const r = await hader.pushContacts(this.deps.sessionId, list, this.linkedPhone);
      logger.info({ sessionId: this.deps.sessionId, sent: list.length, stored: r.stored }, 'contacts pushed');
      await this.finish(null);
    } catch (err) {
      hader.logContactsFailure(err, 'pushContacts');
      // The push is the whole point; if it failed the tenant gets an honest failure
      // rather than a silent unlink and a spinner that never resolves.
      await this.finish('could not deliver contacts');
    }
  }

  /**
   * Log out, destroy the credentials, and report. `logout()` unlinks the device on
   * WhatsApp's side, which frees the tenant's slot — merely closing the socket would
   * leave "Hader Contacts" sitting in their Linked Devices list indefinitely.
   */
  async finish(failureReason: string | null): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const t of [this.settleTimer, this.hardTimer, this.deadlineTimer, this.initialTimer])
      if (t) clearTimeout(t);

    const sock = this.sock as unknown as {
      logout?: () => Promise<void>;
      end?: (e?: Error) => void;
    } | null;
    try {
      await sock?.logout?.();
    } catch {
      // Already gone, or never paired. Fall through — the credential purge below is the
      // part that must happen regardless.
    }
    try {
      sock?.end?.(undefined);
    } catch {
      /* noop */
    }
    this.sock = null;

    // Purge credentials unconditionally. This is the compensating path that makes the
    // "we unlink when we are done" promise true even when logout() failed.
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err, sessionId: this.deps.sessionId }, 'FAILED to purge contacts auth dir');
    }

    if (failureReason) {
      await hader
        .reportEnded(this.deps.sessionId, failureReason)
        .catch((err) => hader.logContactsFailure(err, 'reportEnded'));
    }
    this.deps.onDone(this.deps.sessionId);
  }
}
