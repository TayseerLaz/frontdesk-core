// The numbers that belong to the BUSINESS ITSELF, so a phone sync never imports the tenant
// as their own customer.
//
// WHY THIS IS NOT COSMETIC. An iPhone "All Contacts" export always includes the owner's own
// card, and every address book holds the shop's own line. Imported, those become ordinary
// contacts — which means they are eligible for broadcast audiences, so a campaign can message
// the business's own WhatsApp number. That number is the bot. It would receive its own
// marketing, and on a metered wallet the tenant pays for it.
//
// WHAT THIS DELIBERATELY DOES NOT DO: guess. There is no reliable marker for Apple's "My
// Card" in an exported .vcf — it is written as an ordinary VCARD — so guessing which card is
// "me" would eventually drop a real customer. Everything matched here is a number the
// business has already TOLD us is its own, through a channel it configured. That makes this
// a lookup, not a heuristic. A personal mobile the tenant never registered anywhere is still
// imported; the review screen is the place to untick it.
import { normalizePhone } from './phone-normalize.js';
import { withTenant } from './db.js';

/**
 * Every number this org has declared as its own, normalised to E.164 for comparison.
 *
 * Sources, all authoritative:
 *   · WhatsAppChannel.displayPhoneNumber — the numbers the bot actually sends from
 *   · ContactChannel  — the phone/whatsapp channels shown on the business profile
 *   · PhoneIntegration — dialed numbers routed to the voice bot
 *
 * Everything is run through normalizePhone so a channel stored as "+961 70 123 456" matches
 * an address-book entry stored as "03 123 456"; without that the comparison silently never
 * matches and the whole guard is decorative.
 */
export async function loadOrgOwnNumbers(
  organizationId: string,
  opts: { defaultDialCode?: string | null; extra?: (string | null | undefined)[] } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    // Try the org's dial code first, then bare: a business number is normally stored
    // internationally, but a ContactChannel is free text and often is not.
    const e164 =
      normalizePhone(raw, { defaultDialCode: opts.defaultDialCode ?? null }) ??
      normalizePhone(raw);
    if (e164) out.add(e164);
  };

  for (const v of opts.extra ?? []) add(v);

  const [channels, contactChannels, phones] = await withTenant(organizationId, (tx) =>
    Promise.all([
      tx.whatsAppChannel.findMany({
        where: { organizationId },
        select: { displayPhoneNumber: true },
      }),
      tx.contactChannel.findMany({
        where: { organizationId, kind: { in: ['phone', 'whatsapp'] } },
        select: { value: true },
      }),
      tx.phoneIntegration.findMany({
        where: { organizationId },
        select: { phoneNumber: true },
      }),
    ]),
  );

  for (const c of channels) add(c.displayPhoneNumber);
  for (const c of contactChannels) add(c.value);
  for (const p of phones) add(p.phoneNumber);

  return out;
}

/**
 * Drop the business's own numbers from a normalised sync.
 *
 * Returns the removed count separately rather than folding it into `skipped`: those entries
 * had a perfectly usable phone number, and reporting them under "no usable phone number"
 * would be false — the exact class of mislabelling this feature has already had to correct.
 */
export function excludeOwnNumbers<T extends { phoneE164: string }>(
  contacts: T[],
  own: Set<string>,
): { kept: T[]; removed: number } {
  if (own.size === 0) return { kept: contacts, removed: 0 };
  const kept = contacts.filter((c) => !own.has(c.phoneE164));
  return { kept, removed: contacts.length - kept.length };
}
