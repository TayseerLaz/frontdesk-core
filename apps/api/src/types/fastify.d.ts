import 'fastify';

import type { OrgRole } from '@platform/shared';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      userId: string;
      organizationId: string;
      role: OrgRole;
      isSuperAdmin: boolean;
      sessionId: string;
    };
  }
}
