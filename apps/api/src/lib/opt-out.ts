// Shared contact opt-out handling: when a customer unsubscribes (a STOP message
// or a marketing-template opt-out button), we tag the contact and write an
// audit entry. Reused by the WhatsApp + Messenger inbound paths.
import { recordAudit } from './audit.js';
import type { Tx } from './db.js';

/** Tag applied to any contact who unsubscribes. Also filterable on /contacts. */
export const UNSUBSCRIBE_TAG = 'unsubscribed';

/**
 * Tag a contact who opted out + (only on a NEW opt-out) write an audit entry
 * visible to the tenant AND ALIGNED HQ. Idempotent: the tag is unique-
 * constrained (skipDuplicates), and the audit fires only when wasNewlyOptedOut
 * so repeated STOP messages don't spam the activity log. The tag write uses the
 * passed (tenant/bypass) tx; recordAudit runs in its own transaction.
 */
export async function recordContactOptOut(
  tx: Tx,
  args: {
    organizationId: string;
    contactId: string;
    phoneE164: string;
    channel: string;
    wasNewlyOptedOut: boolean;
  },
): Promise<void> {
  await tx.contactTag.createMany({
    data: [{ organizationId: args.organizationId, contactId: args.contactId, tag: UNSUBSCRIBE_TAG }],
    skipDuplicates: true,
  });
  if (args.wasNewlyOptedOut) {
    await recordAudit({
      action: 'contact_unsubscribed',
      organizationId: args.organizationId,
      entityType: 'contact',
      entityId: args.contactId,
      metadata: { channel: args.channel, phone: args.phoneE164, tag: UNSUBSCRIBE_TAG },
    });
  }
}
