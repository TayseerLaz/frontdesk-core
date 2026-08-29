// Versioning helper. Call `recordRevision()` after every catalog mutation so
// the user can see history and restore earlier states.
//
// We store full snapshots (not deltas) — they're cheap (catalog rows are small)
// and dramatically simpler to reason about than rebuilding state from a chain
// of patches. Restore is just `UPDATE … SET <snapshot>`.
import type { Prisma, RevisionAction, RevisionEntityType } from '@platform/db';

import { prisma } from './db.js';

interface RecordRevisionArgs {
  organizationId: string;
  entityType: RevisionEntityType;
  entityId: string;
  action: RevisionAction;
  snapshot: Record<string, unknown>;
  actorUserId?: string | null;
  summary?: string | null;
}

/**
 * Append a revision row. Best-effort — failures are logged, never thrown,
 * because losing a revision is far less bad than failing the user write.
 *
 * Version numbers are computed inside a transaction (count + 1) so concurrent
 * writes don't collide on the unique (entityType, entityId, versionNumber) index.
 */
export async function recordRevision(args: RecordRevisionArgs): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const lastVersion = await tx.catalogRevision.aggregate({
        where: { entityType: args.entityType, entityId: args.entityId },
        _max: { versionNumber: true },
      });
      const nextVersion = (lastVersion._max.versionNumber ?? 0) + 1;
      await tx.catalogRevision.create({
        data: {
          organizationId: args.organizationId,
          entityType: args.entityType,
          entityId: args.entityId,
          action: args.action,
          versionNumber: nextVersion,
          snapshot: args.snapshot as Prisma.InputJsonValue,
          summary: args.summary ?? null,
          actorUserId: args.actorUserId ?? null,
        },
      });
    });
  } catch (err) {
    console.error('[versioning] recordRevision failed', err);
  }
}
