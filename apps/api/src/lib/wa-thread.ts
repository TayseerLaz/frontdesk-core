// Multi-number WhatsApp thread resolution.
//
// A WhatsApp thread belongs to a specific number (whatsAppChannelId) so the
// inbox shows one conversation per number and replies go out from the right
// number. Dedup is enforced by two PARTIAL unique indexes (see the
// 20260623120000_multi_number_whatsapp migration), which Prisma can't express
// as an @@unique — so we can't use `upsert`. This helper is the find-or-create
// replacement: it matches the partial indexes exactly and retries once on a
// unique-violation race.
import type { Prisma } from '@platform/db';

import type { Tx } from './db.js';

export interface UpsertWaThreadArgs {
  organizationId: string;
  customerPhone: string;
  // The WhatsApp number this thread belongs to. NULL for messenger/IG and any
  // WhatsApp thread whose number couldn't be resolved.
  whatsAppChannelId?: string | null;
  // Fields to set when creating (org/phone/channel are supplied by the helper).
  create: Omit<
    Prisma.WhatsAppThreadUncheckedCreateInput,
    'organizationId' | 'customerPhone' | 'whatsAppChannelId'
  >;
  // Fields to apply when the thread already exists.
  update: Prisma.WhatsAppThreadUpdateInput;
}

export async function upsertWaThread(tx: Tx, args: UpsertWaThreadArgs) {
  const whatsAppChannelId = args.whatsAppChannelId ?? null;
  const where = {
    organizationId: args.organizationId,
    customerPhone: args.customerPhone,
    whatsAppChannelId,
  } as const;

  const existing = await tx.whatsAppThread.findFirst({ where, select: { id: true } });
  if (existing) {
    return tx.whatsAppThread.update({ where: { id: existing.id }, data: args.update });
  }
  try {
    return await tx.whatsAppThread.create({
      data: {
        ...args.create,
        organizationId: args.organizationId,
        customerPhone: args.customerPhone,
        whatsAppChannelId,
      },
    });
  } catch (err) {
    // Concurrent inbound from the same customer+number: the other request won
    // the create. Re-read and apply the update instead. (Duck-type the Prisma
    // unique-violation code so we don't need the runtime Prisma namespace.)
    if ((err as { code?: string } | null)?.code === 'P2002') {
      const again = await tx.whatsAppThread.findFirst({ where, select: { id: true } });
      if (again) return tx.whatsAppThread.update({ where: { id: again.id }, data: args.update });
    }
    throw err;
  }
}
