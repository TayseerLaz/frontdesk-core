import type { AuditAction } from '@platform/db';
import { encryptJsonSecret } from '@platform/db';

import { prisma } from './db.js';

interface RecordAuditArgs {
  action: AuditAction;
  organizationId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Write an audit row using RLS bypass (the audit log itself doesn't run inside
 * a per-tenant transaction). Failures are logged but never thrown — auditing
 * must never break the user request.
 */
export async function recordAudit(args: RecordAuditArgs): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.auditLog.create({
        data: {
          action: args.action,
          organizationId: args.organizationId ?? null,
          actorUserId: args.actorUserId ?? null,
          entityType: args.entityType,
          entityId: args.entityId,
          metadata: (args.metadata ?? undefined) as never,
          ipAddress: args.ipAddress ?? undefined,
          userAgent: args.userAgent ?? undefined,
        },
      });
    });
  } catch (err) {
    console.error('[audit] failed to record', args.action, err);
  }
}

/**
 * Record integration credentials a tenant entered (WhatsApp / Messenger /
 * Instagram / Shopify connector / payments…). ALIGNED-HQ-only: the tenant's own
 * audit view hides `integration_credentials_set`, and the credential VALUES are
 * AES-256-GCM encrypted in the metadata (`credentialsEnc`) — decrypted only in
 * the ALIGNED-admin audit view. Captured on every save, whether it worked or
 * not, so HQ can support a tenant who can't get a connection live.
 */
export async function recordCredentialAudit(args: {
  organizationId: string;
  actorUserId?: string | null;
  integration: string;
  /** Raw values the tenant entered — only non-empty ones are recorded. */
  credentials: Record<string, unknown>;
  status?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const entries = Object.entries(args.credentials).filter(
    ([, v]) => v != null && String(v).trim() !== '',
  );
  if (entries.length === 0) return; // nothing entered — don't log an empty save
  const fieldsSet = entries.map(([k]) => k);
  const cleaned = Object.fromEntries(entries);
  await recordAudit({
    action: 'integration_credentials_set',
    organizationId: args.organizationId,
    actorUserId: args.actorUserId ?? null,
    entityType: 'integration',
    // entity_id is a UUID column — the integration name isn't a UUID, so it
    // lives in entityType + metadata.integration. (Passing the name here made
    // the credential-trail insert fail the UUID parse for every integration.)
    entityId: undefined,
    metadata: {
      integration: args.integration,
      fieldsSet,
      status: args.status ?? 'saved',
      // Opaque encrypted blob — never plaintext at rest.
      credentialsEnc: encryptJsonSecret(cleaned),
    },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
}
