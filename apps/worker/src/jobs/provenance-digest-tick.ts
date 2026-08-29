// Phase 8 / 1.4 — daily provenance digest.
//
// Runs once a day. Aggregates the prior 24 hours of `message_provenances`
// rows by org, counts how many had hallucinations flagged, and emails a
// single summary to every user with `isSuperAdmin = true`. Body is a
// per-org breakdown with up to N flagged examples.
//
// Skipped silently when there are zero flagged replies in the window
// (no inbox spam on quiet days). Distributed-locked via Redis so multiple
// worker replicas don't double-send.

import { withRlsBypass } from './db.js';
import { env } from '../lib/env.js';
import { sendEmail } from '../lib/email.js';
import { getConnection } from '../lib/redis.js';

const TICK_INTERVAL_MS = Number(
  process.env.PROVENANCE_DIGEST_TICK_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);
const WINDOW_MS = Number(process.env.PROVENANCE_DIGEST_WINDOW_MS ?? 24 * 60 * 60 * 1000);
const MAX_EXAMPLES_PER_ORG = Number(process.env.PROVENANCE_DIGEST_MAX_EXAMPLES ?? 5);
const LOCK_KEY = 'lock:provenance-digest-tick';
// Add a 2-hour clock skew tolerance so a redeploy mid-tick doesn't fire
// the digest a second time.
const LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 2 * 60 * 60;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

interface FlaggedRow {
  organization_id: string;
  org_name: string;
  org_slug: string;
  message_id: string;
  body: string | null;
  halluc_count: number;
  hallucinations: unknown;
  created_at: Date;
}

async function tick(): Promise<void> {
  const redis = getConnection();
  const lock = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;

  const since = new Date(Date.now() - WINDOW_MS);

  const flaggedRows = await withRlsBypass(async (tx) => {
    return tx.$queryRaw<FlaggedRow[]>`
      SELECT
        p.organization_id,
        o.name AS org_name,
        o.slug AS org_slug,
        p.message_id,
        m.body,
        jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) AS halluc_count,
        p.hallucinations,
        p.created_at
      FROM message_provenances p
      JOIN organizations o ON o.id = p.organization_id
      LEFT JOIN whatsapp_messages m ON m.id = p.message_id
      WHERE p.created_at >= ${since}
        AND jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0
      ORDER BY p.created_at DESC
    `;
  });

  if (flaggedRows.length === 0) {
    console.log('[provenance-digest] no flagged replies in window — skipping email');
    return;
  }

  // Group by org. Map iteration order in JS preserves insertion order so
  // the first-seen org appears first in the email.
  const byOrg = new Map<
    string,
    { name: string; slug: string; rows: FlaggedRow[] }
  >();
  for (const r of flaggedRows) {
    let g = byOrg.get(r.organization_id);
    if (!g) {
      g = { name: r.org_name, slug: r.org_slug, rows: [] };
      byOrg.set(r.organization_id, g);
    }
    g.rows.push(r);
  }

  const admins = await withRlsBypass((tx) =>
    tx.user.findMany({
      where: { isSuperAdmin: true, status: 'active' },
      select: { email: true, firstName: true, lastName: true },
    }),
  );
  if (admins.length === 0) {
    console.log('[provenance-digest] no super-admins to email — skipping');
    return;
  }

  const totalFlagged = flaggedRows.length;
  const totalOrgs = byOrg.size;
  const subject = `[the platform] ${totalFlagged} flagged bot repl${totalFlagged === 1 ? 'y' : 'ies'} across ${totalOrgs} tenant${totalOrgs === 1 ? '' : 's'} in the last 24h`;

  const portalBase = env.WEB_PUBLIC_URL.replace(/\/$/, '');

  const textLines: string[] = [
    `the platform — daily bot-reply audit digest`,
    ``,
    `Window: last ${(WINDOW_MS / 3_600_000).toFixed(0)} hours`,
    `Total flagged replies: ${totalFlagged}`,
    `Affected tenants: ${totalOrgs}`,
    ``,
  ];
  const htmlSections: string[] = [];

  for (const [orgId, g] of byOrg) {
    textLines.push(`--- ${g.name} (${g.slug}) · ${g.rows.length} flagged ---`);
    htmlSections.push(
      `<h3 style="margin:18px 0 6px;font-size:14px;">${escapeHtml(g.name)} <span style="color:#777;font-weight:normal">(${escapeHtml(g.slug)}) · ${g.rows.length} flagged</span></h3>`,
    );
    const items: string[] = [];
    for (const r of g.rows.slice(0, MAX_EXAMPLES_PER_ORG)) {
      const hals = Array.isArray(r.hallucinations)
        ? (r.hallucinations as { matchedText?: string; severity?: string; reason?: string }[])
        : [];
      const sample = hals
        .slice(0, 2)
        .map((h) => `${(h.severity ?? 'warn').toUpperCase()}: ${h.matchedText ?? '?'}`)
        .join(' · ');
      textLines.push(
        `  • ${r.created_at.toISOString()} — ${sample}\n    body: ${(r.body ?? '').slice(0, 140)}`,
      );
      items.push(
        `<li style="margin:6px 0;"><div style="font-size:11px;color:#777;">${r.created_at.toISOString()}</div><div style="font-weight:600;font-size:12px;">${escapeHtml(sample)}</div><div style="font-size:12px;color:#444;font-style:italic;">"${escapeHtml((r.body ?? '').slice(0, 200))}"</div></li>`,
      );
    }
    if (g.rows.length > MAX_EXAMPLES_PER_ORG) {
      const more = g.rows.length - MAX_EXAMPLES_PER_ORG;
      textLines.push(`  …and ${more} more.`);
      items.push(`<li style="color:#777;font-size:11px;">…and ${more} more.</li>`);
    }
    htmlSections.push(`<ul style="padding-left:18px;margin:0 0 12px;">${items.join('')}</ul>`);
    textLines.push('');
  }

  textLines.push(`Browse all: ${portalBase}/hq/provenance?flagged=true`);

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#222;">
  <h2 style="margin:0 0 4px;font-size:18px;">the platform — daily bot-reply audit</h2>
  <p style="margin:0 0 16px;color:#666;font-size:13px;">
    ${totalFlagged} flagged repl${totalFlagged === 1 ? 'y' : 'ies'} across
    ${totalOrgs} tenant${totalOrgs === 1 ? '' : 's'} in the last
    ${(WINDOW_MS / 3_600_000).toFixed(0)} hours.
  </p>
  ${htmlSections.join('\n')}
  <hr style="border:0;border-top:1px solid #eee;margin:18px 0 12px;">
  <p style="font-size:12px;color:#666;">
    <a href="${portalBase}/hq/provenance?flagged=true" style="color:#0070f3;">Open the full provenance browser →</a>
  </p>
</body></html>`;

  const text = textLines.join('\n');

  let sentTo = 0;
  for (const admin of admins) {
    try {
      await sendEmail({ to: admin.email, subject, text, html });
      sentTo += 1;
    } catch (err) {
      console.error('[provenance-digest] send failed', { to: admin.email, err });
    }
  }
  console.log(
    `[provenance-digest] sent ${sentTo}/${admins.length} admin emails — ${totalFlagged} flagged across ${totalOrgs} orgs`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function startProvenanceDigestTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[provenance-digest] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Initial run 5 min after boot — lets the API + worker stabilise.
  // The Redis distributed lock will silently skip if another replica
  // already ran the digest within the TTL window.
  timer = setTimeout(run, 5 * 60 * 1000);
  return {
    name: 'provenance-digest-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
