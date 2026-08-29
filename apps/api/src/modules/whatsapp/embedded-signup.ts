export interface MetaDebugTokenPayload {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    granular_scopes?: Array<{
      scope?: string;
      target_ids?: string[];
    }>;
  };
  error?: { message?: string; code?: number };
}

export type WabaDiscoveryResult =
  | { ok: true; wabaId: string; candidates: string[] }
  | {
      ok: false;
      status: 'token_invalid' | 'app_mismatch' | 'waba_not_authorized' | 'waba_ambiguous';
      message: string;
      candidates: string[];
    };

/**
 * Resolve the WABA granted to an Embedded Signup business token.
 *
 * Browser postMessage is treated only as a claim. Granular scopes are the
 * server-side source of truth when Meta returns the authorization code without
 * delivering the session event to window.opener.
 */
export function discoverEmbeddedSignupWaba(
  payload: MetaDebugTokenPayload,
  expectedAppId: string,
  claimedWabaId?: string,
): WabaDiscoveryResult {
  const data = payload.data;
  if (!data || data.is_valid === false) {
    return {
      ok: false,
      status: 'token_invalid',
      message: 'Meta returned an invalid Embedded Signup access token.',
      candidates: [],
    };
  }
  if (data.app_id && data.app_id !== expectedAppId) {
    return {
      ok: false,
      status: 'app_mismatch',
      message: 'The Embedded Signup token belongs to a different Meta app.',
      candidates: [],
    };
  }

  const scopes = data.granular_scopes ?? [];
  const targetsFor = (scopeName: string): string[] =>
    scopes
      .filter((scope) => scope.scope === scopeName)
      .flatMap((scope) => scope.target_ids ?? [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

  // Management targets are WABA ids. Messaging targets are used only as a
  // compatibility fallback for Meta variants that omit management targets.
  const managementTargets = targetsFor('whatsapp_business_management');
  const candidates = [
    ...new Set(
      managementTargets.length > 0
        ? managementTargets
        : targetsFor('whatsapp_business_messaging'),
    ),
  ];

  if (claimedWabaId) {
    if (candidates.length > 0 && !candidates.includes(claimedWabaId)) {
      return {
        ok: false,
        status: 'waba_not_authorized',
        message: 'The WhatsApp account reported by the browser was not granted to this token.',
        candidates,
      };
    }
    return { ok: true, wabaId: claimedWabaId, candidates };
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      status: 'waba_ambiguous',
      message:
        candidates.length === 0
          ? 'Meta did not identify a WhatsApp Business Account in the granted token.'
          : 'Meta granted more than one WhatsApp Business Account, so we cannot choose one safely.',
      candidates,
    };
  }
  return { ok: true, wabaId: candidates[0]!, candidates };
}

export function isCallbackOverrideConfirmed(
  payload: { data?: Array<{ override_callback_uri?: string }> },
  expectedCallback: string,
): boolean {
  return (payload.data ?? []).some((entry) => entry.override_callback_uri === expectedCallback);
}

/** Extract every routing hint before selecting an HMAC key. */
export function extractWebhookRoutingHints(payload: unknown): {
  phoneNumberIds: string[];
  wabaIds: string[];
} {
  const body = (payload ?? {}) as {
    entry?: Array<{
      id?: unknown;
      changes?: Array<{ value?: { metadata?: { phone_number_id?: unknown } } }>;
    }>;
  };
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const phoneNumberIds = [
    ...new Set(
      entries
        .flatMap((entry) => (Array.isArray(entry.changes) ? entry.changes : []))
        .map((change) => change.value?.metadata?.phone_number_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const wabaIds = [
    ...new Set(
      entries
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  return { phoneNumberIds, wabaIds };
}
