// EventSource cannot set Authorization headers, so we authenticate SSE by
// exchanging the session for a short-lived single-use nonce via
// POST /api/v1/auth/sse-nonce, then connect with `?nonce=<value>`. The
// nonce is consumed atomically server-side (GETDEL on Redis), so even a
// leaked URL is worthless after the SSE connection is established.
//
// Browser auto-reconnect can't reuse a single-use nonce, so this helper
// owns its own reconnect loop — on error it closes, waits with exponential
// backoff, fetches a fresh nonce, and reopens.
import { api, ApiError } from './api';

export type SseHandlers = {
  onHello?: (data: unknown) => void;
  onTick?: () => void;
  onEvent?: (name: string, data: unknown) => void;
  /** Targeted per-user frames — e.g. "a conversation was assigned to you".
      The server only sends these on connections authenticated as the target
      user, so a handler can chime without further filtering. */
  onNotify?: (data: { kind: string; threadId: string; title: string; body: string | null }) => void;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BACKOFF_MS = 30_000;
// After this many consecutive nonce-or-stream failures the helper gives
// up. Previously the loop ran forever — on a dead session it would
// hammer /sse-nonce + /auth/refresh every 30s producing a wall of 401s
// in the browser console. 6 attempts with exponential backoff caps the
// damage at ~60s of retry storm before silently bowing out.
const MAX_CONSECUTIVE_FAILURES = 6;

/**
 * Open an authenticated EventSource at the given API path.
 * Returns a disposer; call it on unmount to close the stream.
 */
export function connectSse(path: string, handlers: SseHandlers): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let gaveUp = false;

  const scheduleReopen = () => {
    if (closed || reconnectTimer || gaveUp) return;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      gaveUp = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[sse] gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures opening ${path}. ` +
          'Likely an expired session. Refresh the page after signing in to restore live updates.',
      );
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void open();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const open = async () => {
    if (closed || gaveUp) return;
    try {
      const { nonce } = await api.post<{ nonce: string }>('/api/v1/auth/sse-nonce');
      if (closed) return;
      const url = `${API_BASE}${path}?nonce=${encodeURIComponent(nonce)}`;
      const source = new EventSource(url, { withCredentials: true });
      es = source;
      source.addEventListener('open', () => {
        // Reset backoff + failure counter once the server accepts the
        // nonce and holds the stream open. Fresh retries from here.
        backoff = 1000;
        consecutiveFailures = 0;
      });
      if (handlers.onTick) source.addEventListener('tick', () => handlers.onTick!());
      if (handlers.onNotify) {
        source.addEventListener('notify', (ev) => {
          try {
            handlers.onNotify!(JSON.parse((ev as MessageEvent).data));
          } catch {
            // ignore — server sent malformed JSON
          }
        });
      }
      if (handlers.onHello) {
        source.addEventListener('hello', (ev) => {
          try {
            handlers.onHello!(JSON.parse((ev as MessageEvent).data));
          } catch {
            // ignore — server sent malformed JSON
          }
        });
      }
      if (handlers.onEvent) {
        source.addEventListener('message', (ev) => {
          try {
            handlers.onEvent!('message', JSON.parse((ev as MessageEvent).data));
          } catch {
            handlers.onEvent!('message', (ev as MessageEvent).data);
          }
        });
      }
      source.onerror = () => {
        try {
          source.close();
        } catch {
          // noop
        }
        if (es === source) es = null;
        consecutiveFailures += 1;
        scheduleReopen();
      };
    } catch (err) {
      consecutiveFailures += 1;
      // 401 on the nonce-exchange = session is gone. Don't burn the
      // remaining retries hammering the API — give up immediately and
      // let the session manager redirect the user to /login on the
      // next page navigation.
      if (err instanceof ApiError && err.status === 401) {
        gaveUp = true;
        return;
      }
      scheduleReopen();
    }
  };

  void open();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      es?.close();
    } catch {
      // noop
    }
    es = null;
  };
}
