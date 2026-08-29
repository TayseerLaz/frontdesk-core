// Reusable per-tenant feature guard.
//
// Hader has no central feature-assert helper — each surface hand-rolls
// `org.disabledFeatures.includes(key)` (e.g. shopify.routes.ts assertEnabled,
// the inline 'ai'/'voice_transcription' checks in whatsapp.routes.ts). This
// centralizes it so the Alinia listings surfaces (ingest route, listings API)
// — and future features — share one implementation and one error shape.
import { ApiErrorCode } from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { forbidden } from './errors.js';

/**
 * Throw FEATURE_DISABLED (403) when `key` is in the org's disabledFeatures.
 * Returns the resolved organizationId on success. Reads under the tenant
 * (RLS-scoped) connection, exactly like shopify's inline assertEnabled.
 */
export async function assertOrgFeature(
  app: FastifyInstance,
  req: FastifyRequest,
  key: string,
  message?: string,
): Promise<string> {
  const orgId = req.auth!.organizationId;
  const org = await app.tenant(req, (tx) =>
    tx.organization.findUnique({
      where: { id: orgId },
      select: { disabledFeatures: true },
    }),
  );
  if (org?.disabledFeatures?.includes(key)) {
    throw forbidden(
      ApiErrorCode.FEATURE_DISABLED,
      message ?? 'This feature is not enabled for your account.',
    );
  }
  return orgId;
}
