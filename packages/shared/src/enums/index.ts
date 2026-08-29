// Mirror of Prisma enums. Kept here so the web app does not depend on @prisma/client.
// If you add a value to schema.prisma, also add it here.
export * from './catalog.js';
export * from './day3.js';
export * from './day4.js';
export * from './phase4.js';




export const OrgRole = {
  admin: 'admin',
  editor: 'editor',
  viewer: 'viewer',
} as const;
export type OrgRole = (typeof OrgRole)[keyof typeof OrgRole];
export const ORG_ROLES = Object.values(OrgRole) as OrgRole[];

export const OrgStatus = {
  active: 'active',
  suspended: 'suspended',
  deleted: 'deleted',
} as const;
export type OrgStatus = (typeof OrgStatus)[keyof typeof OrgStatus];

export const UserStatus = {
  pending: 'pending',
  active: 'active',
  disabled: 'disabled',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const InvitationStatus = {
  pending: 'pending',
  accepted: 'accepted',
  revoked: 'revoked',
  expired: 'expired',
} as const;
export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];

// Friendly labels for UI
export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

export const ORG_ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  admin: 'Full access to data, users, API connections, and bot configuration.',
  editor: 'Can add, edit, and import product/service data. Cannot manage users or API connections.',
  viewer: 'Read-only access to data and dashboards.',
};
