// Draft-cart sweeper.
//
// The bot maintains a Cart row with status='draft' as the customer
// adds items via WhatsApp. Drafts that never reach the [CART:] marker
// (customer ghosts, conversation peters out) accumulate forever
// otherwise. This tick cancels drafts older than DRAFT_TTL_DAYS so the
// table doesn't grow unbounded.
//
// Cancellation, not deletion, so cross-tenant audit + analytics can
// still see how many abandoned carts each org has. Operators can
// distinguish ghost-abandonment from explicit cancellation by the
// `updatedAt` lag versus the chat's `lastMessageAt`.

import { prisma } from '@platform/db';

const DRAFT_TTL_DAYS = 14;
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.cart.updateMany({
    where: {
      status: 'draft',
      updatedAt: { lt: cutoff },
    },
    data: { status: 'cancelled' },
  });
  if (result.count > 0) {
    console.log(
      `[draft-cart-ttl] cancelled ${result.count} draft cart(s) older than ${DRAFT_TTL_DAYS} day(s)`,
    );
  }
}

export function startDraftCartTtlTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[draft-cart-ttl] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Initial run 5 minutes after boot — gives other workers room to settle
  // + spreads I/O across replicas.
  timer = setTimeout(run, 5 * 60 * 1000);
  return {
    name: 'draft-cart-ttl',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
