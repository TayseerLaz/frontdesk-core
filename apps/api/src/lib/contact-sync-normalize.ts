// Pure normalisation for "Sync contacts with phone".
//
// Deliberately split out of contact-sync.ts and importing NOTHING that touches the DB
// or env. Same reason sales-scan-window.ts exists as its own module: env.ts calls
// process.exit(1) on a missing var, so anything transitively importing it cannot be
// exercised outside a fully-configured environment — which would make exactly the logic
// most worth testing the logic that is never tested.
import { normalizePhone } from './phone-normalize.js';
import { parseVCard, type VCardEntry } from './vcard.js';

export interface RawEntry {
  name?: string | null;
  phones: string[];
  email?: string | null;
  organization?: string | null;
}

export interface NormalizedContact {
  phoneE164: string;
  displayName: string | null;
  email: string | null;
  organization: string | null;
}

export interface NormalizeSummary {
  contacts: NormalizedContact[];
  received: number;
  skipped: number;
}

/**
 * Turn raw address-book entries into contacts we can store: normalise every number,
 * drop the un-dialable, and collapse duplicates.
 *
 * `received` counts entries as the phone sent them; `skipped` counts entries that
 * yielded no usable number. A 1,200-entry address book routinely produces dozens of
 * skips (voicemail shortcuts, service numbers, contacts saved with no number at all),
 * and the tenant should see that number rather than wonder where the rest went.
 */
export function normalizeEntries(
  entries: RawEntry[],
  defaultDialCode: string | null,
): NormalizeSummary {
  const byPhone = new Map<string, NormalizedContact>();
  let received = 0;
  let skipped = 0;

  for (const entry of entries) {
    received += 1;
    const name = entry.name?.trim() || null;
    const email = entry.email?.trim() || null;
    const org = entry.organization?.trim() || null;

    let matchedAny = false;
    for (const rawPhone of entry.phones ?? []) {
      const phoneE164 = normalizePhone(rawPhone, { defaultDialCode });
      if (!phoneE164) continue;
      matchedAny = true;

      const existing = byPhone.get(phoneE164);
      if (existing) {
        // Same number under two entries — keep whichever carries more detail.
        if (!existing.displayName && name) existing.displayName = name;
        if (!existing.email && email) existing.email = email;
        if (!existing.organization && org) existing.organization = org;
        continue;
      }
      byPhone.set(phoneE164, { phoneE164, displayName: name, email, organization: org });
    }

    if (!matchedAny) skipped += 1;
  }

  return { contacts: [...byPhone.values()], received, skipped };
}

export function entriesFromVCard(vcard: string, maxEntries: number): RawEntry[] {
  return parseVCard(vcard, { maxEntries }).map((c: VCardEntry) => ({
    name: c.displayName,
    phones: c.phones,
    email: c.email,
    organization: c.organization,
  }));
}

/**
 * Build the phone-facing URL that gets encoded into the QR.
 *
 * Kept here, pure and parameterised, so the HARD gate can pin it. The first deploy of
 * this feature shipped `${WEB_PUBLIC_URL}/sync/<token>` on the assumption that the env
 * var already carried Next's '/app' basePath. In production it does not — it is the bare
 * origin, and every other minted link only survives that because Caddy has an explicit
 * per-path redirect. There was none for /sync, so the QR resolved to the marketing site,
 * which answered 200 with its own homepage and Login button. Nothing errored; the scan
 * simply asked the tenant to sign in.
 *
 * Idempotent in both directions: WEB_PUBLIC_URL has been set with AND without the
 * basePath in this repo's history, and '/app/app/sync' would fail just as quietly.
 */
export function buildPhoneSyncUrl(webPublicUrl: string, token: string): string {
  const base = webPublicUrl.replace(/\/+$/, '').replace(/\/app$/, '');
  return `${base}/app/sync/${token}`;
}
