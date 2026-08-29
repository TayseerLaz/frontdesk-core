import { Boom } from '@hapi/boom';
import baileys, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { logMsg, logger } from './logger.js';

/**
 * ONE Baileys companion session for ONE tenant's sales number, bound to ONE permission
 * grant.
 *
 * Forked from qr_whatsapp/src/wa/session.ts. That engine reads auction GROUPS; this one
 * reads 1:1 DMs. The reliability engineering is preserved verbatim (serialized start,
 * authGen stale-write guard, liveness watchdog, reconnect-on-close, LID→phone
 * resolution); the two message filters are INVERTED and the send path is deleted.
 *
 * READ-ONLY BY CONSTRUCTION. There is no sendText/sendMedia here and there must never
 * be one — on a tenant's live sales line, read-only is the single largest ban-risk
 * reducer, and a config flag is too weak a guarantee. `markOnlineOnConnect: false`
 * keeps the number invisible; we never mark read and never send presence.
 */

/**
 * Baileys ships a CJS default export. Under NodeNext ESM the namespace object arrives with
 * the callable under `.default`, so the bare import is an object, not a function — which
 * fails at runtime ("makeWASocket is not a function") while typechecking fine. Resolve it
 * once here rather than at each call site.
 */
const makeWASocket: (config: unknown) => WASocket =
  typeof baileys === 'function'
    ? (baileys as unknown as (c: unknown) => WASocket)
    : ((baileys as unknown as { default: (c: unknown) => WASocket }).default);

const waLogger: any = pino({ level: 'warn' });
const WATCHDOG_INTERVAL_MS = 90_000;

export type SessionStatus = 'starting' | 'qr' | 'pairing' | 'open' | 'closed' | 'logged_out';

export interface CapturedMessage {
  waMsgId: string;
  /**
   * Counterparty phone digits (the OTHER party, whichever direction). In a GROUP this is
   * the individual participant who spoke, never the group's own JID — a group JID has no
   * phone, and attributing a whole group to one pseudonym would fuse strangers together.
   */
  counterpartyPhone: string;
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  /** Group chat rather than a 1:1 DM. The row's group-vs-dm tag. */
  isGroup: boolean;
  /** Group subject when known; null for DMs. Free text, stripped server-side. */
  chatName: string | null;
  sentAt: Date;
  live: boolean;
}

export interface SessionHooks {
  onStatus: (s: SessionStatus, extra: { qr?: string | null; pairingCode?: string | null; phone?: string | null }) => void;
  onMessages: (msgs: CapturedMessage[]) => Promise<void>;
  /**
   * Asked before every socket construction AND on every inbound batch. Returning false
   * tears the session down immediately.
   *
   * Blocker B2/B3: the window deadline must be enforced on the message path, not only
   * by a timer — a wedged reaper must not be able to extend a capture window, and a
   * process restart must not resurrect a grant that already ended.
   */
  isStillAuthorised: () => Promise<boolean>;
}

function phoneFromJid(jid: string | null | undefined): string {
  if (!jid) return '';
  const at = jid.split('@')[0] ?? '';
  // Strip a device suffix (`:12`) if present, then keep digits only.
  return (at.split(':')[0] ?? '').replace(/\D/g, '');
}

/** Text out of the many shapes Baileys uses, plus a coarse kind label. */
function classify(m: any): { kind: string; body: string | null } {
  if (!m) return { kind: 'unknown', body: null };
  if (m.conversation) return { kind: 'text', body: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: 'text', body: m.extendedTextMessage.text };
  if (m.imageMessage) return { kind: 'image', body: m.imageMessage.caption ?? null };
  if (m.videoMessage) return { kind: 'video', body: m.videoMessage.caption ?? null };
  if (m.audioMessage) return { kind: 'audio', body: null };
  if (m.documentMessage) return { kind: 'document', body: m.documentMessage.caption ?? null };
  if (m.stickerMessage) return { kind: 'sticker', body: null };
  if (m.locationMessage) return { kind: 'location', body: null };
  if (m.contactMessage) return { kind: 'contact', body: null };
  if (m.reactionMessage) return { kind: 'reaction', body: m.reactionMessage.text ?? null };
  if (m.buttonsResponseMessage?.selectedDisplayText)
    return { kind: 'text', body: m.buttonsResponseMessage.selectedDisplayText };
  if (m.listResponseMessage?.title) return { kind: 'text', body: m.listResponseMessage.title };
  return { kind: 'other', body: null };
}

export interface AuthStore {
  state: { creds: any; keys: any };
  saveCreds: () => Promise<void>;
}

export class CaptureSession {
  readonly grantId: string;
  private readonly hooks: SessionHooks;
  private readonly auth: AuthStore;
  private readonly pairPhone: string | null;

  private sock: WASocket | null = null;
  private status: SessionStatus = 'starting';
  private latestQrDataUrl: string | null = null;
  private pairingCode: string | null = null;
  private pairRequested = false;
  private phone: string | null = null;

  private starting: Promise<void> | null = null;
  private authGen = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  private stopped = false;
  /**
   * Group JID -> subject, populated ONLY from events Baileys pushes us anyway. There is
   * deliberately no on-demand `groupMetadata()` fetch: a group whose subject we never hear
   * about simply exports with an empty chat_name, which is a better outcome than extra
   * unofficial-client queries against a tenant's live sales line. Bounded so a number in
   * hundreds of groups cannot grow it without limit.
   */
  private readonly groupSubjects = new Map<string, string>();

  constructor(opts: { grantId: string; auth: AuthStore; hooks: SessionHooks; pairPhone?: string | null }) {
    this.grantId = opts.grantId;
    this.auth = opts.auth;
    this.hooks = opts.hooks;
    this.pairPhone = opts.pairPhone ?? null;
  }

  getStatus() {
    return {
      grantId: this.grantId,
      status: this.status,
      qr: this.latestQrDataUrl,
      pairingCode: this.pairingCode,
      phone: this.phone,
    };
  }

  private setStatus(s: SessionStatus): void {
    this.status = s;
    this.hooks.onStatus(s, { qr: this.latestQrDataUrl, pairingCode: this.pairingCode, phone: this.phone });
  }

  /** Serialized: concurrent start() calls share one in-flight attempt. */
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    // B2: never construct a socket for a grant that is no longer authorised. This is
    // what stops a restart from resurrecting a window that already ended.
    if (!(await this.hooks.isStillAuthorised())) {
      logger.warn({ grantId: this.grantId }, 'refusing to start — grant not authorised');
      await this.stop();
      return;
    }

    this.stopWatchdog();
    this.authGen++;
    const myGen = this.authGen;
    this.teardownSocket();

    const { version } = await fetchLatestBaileysVersion();

    const config = {
      version,
      auth: {
        creds: this.auth.state.creds,
        keys: makeCacheableSignalKeyStore(this.auth.state.keys, waLogger),
      },
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['the platform', 'Chrome', '120.0.0'],
      // FORWARD-ONLY. qr_whatsapp accepts WhatsApp's recent-history push; we refuse all
      // of it (blocker B8). Two reasons: the consent copy promises a forward window and
      // history would silently reach back past the consent date, and the history blobs
      // are fetched from WhatsApp's CDN, which is itself a ban signal.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false, // stay invisible — read-only
      shouldIgnoreJid: (jid: string) =>
        isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid),
      getMessage: async () => undefined,
    };
    // Cast through any: the per-session browser tuple and our history/ignore predicates
    // don't line up with Baileys' exported SocketConfig type, and its own .d.ts shape
    // shifts between minors. Behaviour is exercised by a real link, not by this type.
    this.sock = makeWASocket(config as any);

    this.sock.ev.on('creds.update', async () => {
      // Stale-write guard: a socket from a previous generation must never overwrite the
      // credentials of the current one.
      if (myGen !== this.authGen) return;
      await this.auth.saveCreds();
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (this.pairPhone && !this.pairRequested) {
          this.pairRequested = true;
          try {
            this.pairingCode = await this.sock!.requestPairingCode(this.pairPhone);
            this.setStatus('pairing');
            return;
          } catch (err) {
            logger.error({ err, grantId: this.grantId }, 'requestPairingCode failed — falling back to QR');
          }
        }
        this.latestQrDataUrl = await QRCode.toDataURL(qr);
        if (this.status !== 'pairing') this.setStatus('qr');
      }

      if (connection === 'open') {
        this.latestQrDataUrl = null;
        this.pairingCode = null;
        this.phone = phoneFromJid(this.sock?.user?.id);
        this.lastInboundAt = Date.now();
        this.setStatus('open');
        this.startWatchdog();
        logger.info({ grantId: this.grantId }, 'capture session open');
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        this.stopWatchdog();

        // A logout means the tenant (or WhatsApp) severed the link. Do NOT retry — that
        // is the ban-amplifying reconnect loop. Surface it so the tenant is told.
        if (code === DisconnectReason.loggedOut) {
          this.setStatus('logged_out');
          logger.warn({ grantId: this.grantId }, 'logged out by WhatsApp/user — not reconnecting');
          return;
        }
        this.setStatus('closed');
        this.scheduleReconnect();
      }
    });

    // Passive group-subject learning. Both events are pushed by Baileys during its normal
    // app-state sync; neither is a request we initiate. Read-only by construction still
    // holds — these listeners only observe.
    const rememberSubjects = (groups: unknown) => {
      if (!Array.isArray(groups)) return;
      for (const g of groups as Array<{ id?: string; subject?: string }>) {
        if (!g?.id || !g.subject) continue;
        if (this.groupSubjects.size >= 500 && !this.groupSubjects.has(g.id)) continue;
        this.groupSubjects.set(g.id, g.subject);
      }
    };
    this.sock.ev.on('groups.upsert', rememberSubjects);
    this.sock.ev.on('groups.update', rememberSubjects);

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = live. Anything else is an offline/append flush.
      const live = type === 'notify';
      if (!(await this.hooks.isStillAuthorised())) {
        logger.warn({ grantId: this.grantId }, 'window closed — tearing down mid-batch');
        await this.stop();
        return;
      }
      this.lastInboundAt = Date.now();
      const batch: CapturedMessage[] = [];
      for (const m of messages) {
        const captured = this.toCaptured(m, live);
        if (captured) batch.push(captured);
      }
      if (!batch.length) return;
      try {
        await this.hooks.onMessages(batch);
      } catch (err) {
        // Never let a persistence failure kill the socket.
        logger.error({ err, grantId: this.grantId, count: batch.length }, 'onMessages failed');
      }
    });
  }

  /**
   * THE FORK. qr_whatsapp/src/wa/session.ts:547-550 drops exactly what this feature
   * needs:
   *     if (!jid.endsWith('@g.us')) return;   // dropped every DM
   *     if (waMsg.key.fromMe) return;         // dropped every outgoing message
   * The `fromMe` filter is INVERTED — it becomes the direction, and outbound is the
   * higher-value half since "how they speak" lives in the tenant's own replies.
   *
   * Groups are CAPTURED (owner decision 2026-07-30) and tagged `isGroup`, so a consumer
   * can include or exclude them deliberately. Broadcasts, status and newsletters stay
   * dropped: they are not conversations, so they teach nothing about how the tenant talks.
   */
  private toCaptured(waMsg: WAMessage, live: boolean): CapturedMessage | null {
    const jid = waMsg.key.remoteJid ?? '';
    if (!jid) return null;
    if (
      jid === 'status@broadcast' ||
      isJidStatusBroadcast(jid) ||
      isJidBroadcast(jid) ||
      isJidNewsletter(jid)
    )
      return null;
    if (!waMsg.message) return null;

    const isGroup = jid.endsWith('@g.us');
    const direction: 'in' | 'out' = waMsg.key.fromMe ? 'out' : 'in';
    const { kind, body } = classify(waMsg.message);

    // The conversation's other end. In a DM that is the chat itself; in a GROUP the chat
    // JID carries no phone, so an INBOUND group message is attributed to the participant
    // who actually spoke. An OUTBOUND group message has no single counterparty (the
    // tenant is the speaker), so it is keyed by the group's own stable id — using
    // `participant` there would record the tenant as their own counterparty.
    const key = waMsg.key as {
      remoteJidPn?: string;
      participant?: string;
      participantPn?: string;
    };
    let counterpartyPhone: string;
    if (!isGroup) {
      // Prefer the phone-number JID; key.remoteJid can be an opaque LID.
      counterpartyPhone = phoneFromJid(key.remoteJidPn) || phoneFromJid(jid);
    } else if (direction === 'in') {
      counterpartyPhone =
        phoneFromJid(key.participantPn) || phoneFromJid(key.participant) || phoneFromJid(jid);
    } else {
      counterpartyPhone = phoneFromJid(jid);
    }
    if (!counterpartyPhone) return null;

    const tsSec = Number(waMsg.messageTimestamp ?? 0);
    const sentAt = tsSec > 0 ? new Date(tsSec * 1000) : new Date();

    logMsg('captured', {
      grantId: this.grantId,
      waMsgId: waMsg.key.id ?? '',
      direction,
      kind,
      isGroup,
      length: body?.length ?? 0,
      live,
    });

    return {
      waMsgId: waMsg.key.id ?? '',
      counterpartyPhone,
      direction,
      kind,
      body: body ?? null,
      isGroup,
      // Subject only if a passive event already told us — see groupSubjects. We never make
      // an on-demand groupMetadata() call: extra queries from an unofficial client on a
      // live sales line are exactly the ban signal this service is built to avoid.
      chatName: isGroup ? (this.groupSubjects.get(jid) ?? null) : null,
      sentAt,
      live,
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Gentle, jittered. Aggressive reconnects are a ban signal.
    const delay = 5_000 + Math.floor(Math.random() * 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.healthTimer = setInterval(() => {
      // A socket that claims 'open' but has seen nothing for a long time is a known
      // Baileys half-dead state; bounce it rather than sit silently not capturing.
      const idleMs = Date.now() - this.lastInboundAt;
      if (this.status === 'open' && idleMs > WATCHDOG_INTERVAL_MS * 6) {
        logger.warn({ grantId: this.grantId, idleMs }, 'watchdog: stale socket, restarting');
        void this.start();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private teardownSocket(): void {
    if (!this.sock) return;
    try {
      const ev = this.sock.ev as { removeAllListeners: (e: string) => void };
      for (const e of [
        'connection.update',
        'creds.update',
        'messages.upsert',
        'groups.upsert',
        'groups.update',
      ])
        ev.removeAllListeners(e);
      this.sock.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  /** Idempotent. Does NOT purge credentials — that is the caller's separate, retried step. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    if (this.status !== 'logged_out') this.setStatus('closed');
  }
}
