// Re-attach media assets for inbound WhatsApp messages that lost their
// download — primarily the 2026-08-09 Wasabi InvalidAccessKeyId burst on the
// new server, which made every putObject fail for ~5 hours while the message
// rows persisted fine. Those rows render as dead placeholders in the inbox.
// Meta keeps inbound media downloadable by media id for ~30 days, so this
// re-fetches each one through the same helpers the live webhook uses
// (storeInboundImage / transcribeInboundVoice — both idempotent, both resolve
// the org's primary-channel token themselves).
//
// Run on the box:
//   cd /opt/platform/app && set -a && . ./.env.production && set +a && \
//   pnpm --filter @platform/api exec tsx --conditions=source scripts/backfill-inbound-media.ts
//
// Safe to re-run: only rows still missing mediaAssetId are touched.
import { withRlsBypass } from '../src/lib/db.js';
import {
  storeInboundImage,
  transcribeInboundVoice,
} from '../src/modules/whatsapp/whatsapp.routes.js';

const log = {
  info: (...a: unknown[]) => console.log('   ', ...a),
  warn: (...a: unknown[]) => console.warn('   ', ...a),
};

const rows = await withRlsBypass((tx) =>
  tx.whatsAppMessage.findMany({
    where: {
      direction: 'inbound',
      channel: 'whatsapp',
      mediaAssetId: null,
      metaMessageId: { not: null },
      messageType: { in: ['image', 'sticker', 'video', 'document', 'audio', 'voice'] },
      receivedAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    },
    select: {
      id: true,
      organizationId: true,
      messageType: true,
      metaMessageId: true,
      fromNumber: true,
      receivedAt: true,
      rawPayload: true,
    },
    orderBy: { receivedAt: 'desc' },
  }),
);
console.log(`found ${rows.length} inbound media messages with no stored asset (last 30 days)`);

let restored = 0;
let unrecoverable = 0;
for (const r of rows) {
  const t = r.messageType!;
  const raw = r.rawPayload as Record<string, { id?: string; mime_type?: string } | undefined> | null;
  const media = raw?.[t] ?? (t === 'voice' ? raw?.audio : t === 'audio' ? raw?.voice : undefined);
  const mediaId = media?.id ?? null;
  const mime = media?.mime_type ?? null;
  if (!mediaId) {
    console.warn(`  ✗ ${t} ${r.id} (${r.receivedAt.toISOString()}) — no media id in rawPayload`);
    unrecoverable++;
    continue;
  }
  try {
    if (t === 'audio' || t === 'voice') {
      await transcribeInboundVoice({
        organizationId: r.organizationId,
        mediaId,
        mediaMime: mime,
        wamid: r.metaMessageId,
        customerPhone: r.fromNumber ?? '',
        log,
      });
    } else {
      await storeInboundImage({
        organizationId: r.organizationId,
        mediaId,
        mediaMime: mime,
        wamid: r.metaMessageId,
        kind: t === 'video' ? 'video' : t === 'document' ? 'document' : 'image',
        log,
      });
    }
    const after = await withRlsBypass((tx) =>
      tx.whatsAppMessage.findUnique({ where: { id: r.id }, select: { mediaAssetId: true } }),
    );
    if (after?.mediaAssetId) {
      restored++;
      console.log(`  ✓ ${t} ${r.id} (${r.receivedAt.toISOString()})`);
    } else {
      unrecoverable++;
      console.log(`  ✗ ${t} ${r.id} (${r.receivedAt.toISOString()}) — media expired or gone at Meta`);
    }
  } catch (e) {
    unrecoverable++;
    console.warn(`  ✗ ${t} ${r.id} — ${e instanceof Error ? e.message : String(e)}`);
  }
  await new Promise((res) => setTimeout(res, 250));
}
console.log(`done: ${restored} restored, ${unrecoverable} not recoverable`);
process.exit(0);
