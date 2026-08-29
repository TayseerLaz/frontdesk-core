// F5 — automatic back-in-stock interest capture (roadmap 2026-08-26).
//
// Owner decision: "if a user asked something and it was unavailable or out of
// stock, it flags that this customer asked for this product or service" — no
// opt-in button. Fired fire-and-forget from the WhatsApp inbound path; every
// guard lives here and nothing ever throws to the caller.
//
// Why this can't use ctx.data: gatherBotData deliberately packs only
// AVAILABLE products/services (the bot shouldn't sell what's out of stock),
// so unavailable items are invisible to the reply engine. We load them here —
// per org they're a small set — and match the inbound message against their
// names with the conservative shared matcher.
import { matchUnavailableEntities, type WatchableEntity } from '@platform/shared';

import { withRlsBypass } from './db.js';

export async function captureStockInterest(args: {
  organizationId: string;
  threadId: string | null;
  customerPhone: string; // digits, with or without leading '+'
  inboundText: string | null | undefined;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}): Promise<void> {
  const { organizationId, threadId, customerPhone, inboundText, log } = args;
  try {
    const text = (inboundText ?? '').trim();
    if (!text || text.length > 600) return; // a paste/dump is not an inquiry

    await withRlsBypass(async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { disabledFeatures: true },
      });
      if (!org || org.disabledFeatures.includes('stock_watch')) return;

      // Unavailable-but-real items. Bounded: an org with hundreds of
      // unavailable rows still matches in-memory in microseconds.
      const [products, services] = await Promise.all([
        tx.product.findMany({
          where: { organizationId, deletedAt: null, isAvailable: false },
          select: { id: true, name: true },
          take: 300,
        }),
        tx.service.findMany({
          where: { organizationId, deletedAt: null, isAvailable: false },
          select: { id: true, name: true },
          take: 300,
        }),
      ]);
      if (products.length === 0 && services.length === 0) return;

      const entities: WatchableEntity[] = [
        ...products.map((p) => ({ id: p.id, name: p.name, kind: 'product' as const })),
        ...services.map((s) => ({ id: s.id, name: s.name, kind: 'service' as const })),
      ];
      const matches = matchUnavailableEntities(text, entities);
      if (matches.length === 0) return;

      // The inbound webhook auto-upserts contacts, so this almost always
      // resolves; a missing contact (edge) simply skips — no fabrication.
      const digits = customerPhone.replace(/[^0-9]/g, '');
      const contact = await tx.contact.findFirst({
        where: {
          organizationId,
          phoneE164: { in: [digits, `+${digits}`] },
          deletedAt: null,
        },
        select: { id: true, optedOutAt: true, blockedAt: true },
      });
      if (!contact || contact.optedOutAt || contact.blockedAt) return;

      for (const m of matches) {
        const where = {
          organizationId,
          contactId: contact.id,
          ...(m.kind === 'product' ? { productId: m.id } : { serviceId: m.id }),
        };
        const existing = await tx.stockWatch.findFirst({ where, select: { id: true, notifiedAt: true } });
        if (existing) {
          // A repeat ask AFTER a notification re-arms the watch; a repeat ask
          // while still pending keeps the original inquiry.
          if (existing.notifiedAt) {
            await tx.stockWatch.update({
              where: { id: existing.id },
              data: { notifiedAt: null, inquiryText: text.slice(0, 500), threadId, createdAt: new Date() },
            });
          }
          continue;
        }
        await tx.stockWatch.create({
          data: {
            organizationId,
            contactId: contact.id,
            threadId,
            inquiryText: text.slice(0, 500),
            source: 'bot_auto',
            ...(m.kind === 'product' ? { productId: m.id } : { serviceId: m.id }),
          },
        });
        log.info(
          { organizationId, entity: m.name, kind: m.kind },
          '[stock-watch] customer flagged for back-in-stock',
        );
      }
    });
  } catch (err) {
    log.warn({ err }, '[stock-watch] capture failed (non-fatal)');
  }
}
