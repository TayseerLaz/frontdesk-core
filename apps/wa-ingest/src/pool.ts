import { hasAuth, listAuthGrantIds, loadAuth, purgeAuth } from './auth-store.js';
import { env } from './env.js';
import * as hader from './hader-client.js';
import { logger } from './logger.js';
import { CaptureSession } from './session.js';

/**
 * Owns every live capture session and — more importantly — owns the guarantee that a
 * window actually ends.
 *
 * Hader is the system of record: it holds the grant, the consent and the deadline. This
 * process is a follower. Every loop below re-derives what it is allowed to run from
 * Hader rather than from local state, so local state can never drift into capturing
 * something nobody authorised.
 */
class SessionPool {
  private readonly sessions = new Map<string, CaptureSession>();
  /** Deadline per grant, refreshed from Hader on every reconcile. */
  private readonly deadlines = new Map<string, Date>();
  /** Grants whose credentials still need destroying, retried until they are gone. */
  private readonly pendingPurge = new Set<string>();
  private lastHeartbeatOkAt = Date.now();
  private stopping = false;

  get activeCount(): number {
    return this.sessions.size;
  }

  statuses() {
    return [...this.sessions.values()].map((s) => s.getStatus());
  }

  getStatus(grantId: string) {
    return this.sessions.get(grantId)?.getStatus() ?? null;
  }

  /**
   * Boot reconciliation. Blocker B2: credentials can outlive their grant on disk, so a
   * restart must NOT simply resume whatever it finds. Anything without a live grant is
   * purged before a socket is ever constructed.
   */
  async reconcileOnBoot(): Promise<void> {
    let authorised: hader.AuthorisedGrant[] = [];
    try {
      authorised = await hader.fetchAuthorisedGrants();
    } catch (err) {
      // Fail CLOSED. If we cannot ask who is authorised, we start nothing.
      logger.error({ err }, 'boot: cannot reach Hader — starting no sessions');
      return;
    }
    const live = new Set(authorised.map((g) => g.grantId));
    for (const grantId of listAuthGrantIds()) {
      if (!live.has(grantId)) {
        logger.warn({ grantId }, 'boot: orphan credentials with no live grant — purging');
        this.pendingPurge.add(grantId);
      }
    }
    await this.drainPurges();
    for (const g of authorised) await this.ensureRunning(g);
  }

  /** Start a session for an authorised grant, if we have a free slot. */
  async ensureRunning(grant: hader.AuthorisedGrant): Promise<'running' | 'queued' | 'expired'> {
    const endsAt = new Date(grant.effectiveEndsAt);
    if (Number.isNaN(endsAt.getTime()) || endsAt <= new Date()) {
      await this.endSession(grant.grantId, 'expired');
      return 'expired';
    }
    this.deadlines.set(grant.grantId, endsAt);

    if (this.sessions.has(grant.grantId)) return 'running';
    if (this.sessions.size >= env.MAX_SESSIONS) {
      logger.warn(
        { grantId: grant.grantId, cap: env.MAX_SESSIONS },
        'slot cap reached — grant queued (NOT silently dropped)',
      );
      return 'queued';
    }

    const { state, saveCreds } = await loadAuth(grant.grantId);
    const session = new CaptureSession({
      grantId: grant.grantId,
      auth: { state, saveCreds },
      pairPhone: grant.pairPhone,
      hooks: {
        onStatus: (status, extra) => {
          void hader.pushStatus(grant.grantId, status, extra).catch((e) => hader.logPushFailure(e, 'status'));
          // A logout is terminal — release the slot and purge rather than sit half-dead.
          if (status === 'logged_out') void this.endSession(grant.grantId, 'logged_out');
        },
        onMessages: async (msgs) => {
          await hader.pushMessages(grant.grantId, msgs);
        },
        // Authority check used before every socket construction and every inbound batch.
        isStillAuthorised: async () => {
          if (this.stopping) return false;
          const d = this.deadlines.get(grant.grantId);
          if (!d || d <= new Date()) return false;
          // Dead-man switch: losing contact with the consent authority revokes authority.
          if (Date.now() - this.lastHeartbeatOkAt > env.HEARTBEAT_FAIL_LIMIT_MS) {
            logger.error('heartbeat stale beyond limit — treating capture as unauthorised');
            return false;
          }
          return true;
        },
      },
    });
    this.sessions.set(grant.grantId, session);
    await session.start();
    return 'running';
  }

  /**
   * Stop capturing and queue the credential purge.
   *
   * The two halves are deliberately separate (blocker B1): the status transition is
   * one-shot, but the purge is retried until verified. Bundling them means a purge that
   * fails once can never be retried, and credentials outlive consent silently.
   */
  async endSession(grantId: string, reason: string): Promise<void> {
    const s = this.sessions.get(grantId);
    if (s) {
      await s.stop();
      this.sessions.delete(grantId);
    }
    this.deadlines.delete(grantId);
    this.pendingPurge.add(grantId);
    try {
      await hader.reportEnded(grantId, reason);
    } catch (err) {
      hader.logPushFailure(err, 'ended');
    }
    await this.drainPurges();
  }

  /** Retry every outstanding purge. Only reports success after the bytes are verified gone. */
  private async drainPurges(): Promise<void> {
    for (const grantId of [...this.pendingPurge]) {
      if (hasAuth(grantId) && !purgeAuth(grantId)) {
        logger.error({ grantId }, 'purge failed — will retry on the next sweep');
        continue;
      }
      try {
        await hader.reportPurged(grantId);
        this.pendingPurge.delete(grantId);
      } catch (err) {
        // Keep it pending: authPurgedAt must only be stamped once Hader has been told.
        hader.logPushFailure(err, 'purged');
      }
    }
  }

  /**
   * The supervised loop. Blocker B3: the original design used a bare setInterval, where a
   * single uncaught rejection stops the only thing enforcing the window. This is a
   * while-loop with per-iteration try/catch, so a failure costs one sweep, never the
   * guarantee.
   */
  async runReaper(): Promise<void> {
    while (!this.stopping) {
      try {
        // Expire anything past its deadline first — cheap and local.
        const now = new Date();
        for (const [grantId, endsAt] of [...this.deadlines]) {
          if (endsAt <= now) await this.endSession(grantId, 'window_expired');
        }

        // Then re-derive authority from the system of record.
        const authorised = await hader.fetchAuthorisedGrants();
        this.lastHeartbeatOkAt = Date.now();
        const live = new Set(authorised.map((g) => g.grantId));
        for (const grantId of [...this.sessions.keys()]) {
          if (!live.has(grantId)) await this.endSession(grantId, 'revoked_upstream');
        }
        for (const g of authorised) await this.ensureRunning(g);

        await this.drainPurges();
      } catch (err) {
        logger.error({ err }, 'reaper sweep failed — retrying next interval');
        // Dead-man switch: if this keeps failing we lose authority and tear everything
        // down inside isStillAuthorised(), rather than capturing blind.
        if (Date.now() - this.lastHeartbeatOkAt > env.HEARTBEAT_FAIL_LIMIT_MS && this.sessions.size) {
          logger.error('lost contact with Hader beyond the limit — tearing down all sessions');
          for (const grantId of [...this.sessions.keys()]) {
            const s = this.sessions.get(grantId);
            if (s) await s.stop();
            this.sessions.delete(grantId);
          }
        }
      }
      await new Promise((r) => setTimeout(r, env.REAP_INTERVAL_MS));
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
    this.sessions.clear();
  }
}

export const pool = new SessionPool();
