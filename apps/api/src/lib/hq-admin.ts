import { prisma } from './db.js';

// The HQ organization is identified by this slug. Being an ACTIVE admin
// of it grants platform-wide HQ access (User.isSuperAdmin) — the same access
// as the owner account. Kept as a constant (not an env) so it's obvious +
// greppable; change here if the HQ org is ever re-slugged.
export const HQ_ORG_SLUG = 'platform';

/**
 * Keep User.isSuperAdmin in lockstep with HQ-org admin membership: an ACTIVE
 * admin of the the platform org IS a platform HQ admin (same access as the owner);
 * demote / deactivate / remove them and the flag is revoked, so HQ access never
 * goes stale.
 *
 * NO-OP unless the membership change happened IN the HQ org — so editing
 * memberships in any OTHER org can never touch a user's HQ flag (a manually
 * granted HQ admin who isn't a member of the the platform org is left alone). Uses
 * the owner client because users + memberships are global (not org-scoped).
 */
export async function syncHqAdminForOrgChange(
  organizationId: string,
  userId: string,
): Promise<void> {
  const hqOrg = await prisma.organization.findUnique({
    where: { slug: HQ_ORG_SLUG },
    select: { id: true },
  });
  if (!hqOrg || hqOrg.id !== organizationId) return; // change wasn't in the HQ org

  const adminMembership = await prisma.membership.findFirst({
    where: { organizationId: hqOrg.id, userId, isActive: true, role: 'admin' },
    select: { id: true },
  });
  const shouldBeHqAdmin = !!adminMembership;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isSuperAdmin: true },
  });
  if (!user || user.isSuperAdmin === shouldBeHqAdmin) return;

  await prisma.user.update({
    where: { id: userId },
    data: { isSuperAdmin: shouldBeHqAdmin },
  });
  // Bust the per-org "unlimited plan" cache so isOrgUnlimited re-reads at once.
  try {
    const { getRedis } = await import('./redis.js');
    await getRedis().del(`plan:unlimited:${hqOrg.id}`);
  } catch {
    /* best-effort */
  }
}
