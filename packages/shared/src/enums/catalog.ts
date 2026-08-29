// Catalog enums — mirror schema.prisma. Update both together.

export const PriceUnit = {
  flat: 'flat',
  per_hour: 'per_hour',
  per_day: 'per_day',
  per_session: 'per_session',
  per_unit: 'per_unit',
} as const;
export type PriceUnit = (typeof PriceUnit)[keyof typeof PriceUnit];

export const PRICE_UNIT_LABELS: Record<PriceUnit, string> = {
  flat: 'Flat fee',
  per_hour: 'Per hour',
  per_day: 'Per day',
  per_session: 'Per session',
  per_unit: 'Per unit',
};

export const DayOfWeek = {
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday',
} as const;
export type DayOfWeek = (typeof DayOfWeek)[keyof typeof DayOfWeek];

export const DAYS_OF_WEEK: DayOfWeek[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const DAY_OF_WEEK_LABELS: Record<DayOfWeek, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

export const FaqVisibility = { public: 'public', private: 'private' } as const;
export type FaqVisibility = (typeof FaqVisibility)[keyof typeof FaqVisibility];

export const AssetKind = {
  image: 'image',
  document: 'document',
  csv_upload: 'csv_upload',
  other: 'other',
} as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

export const POLICY_KINDS = ['return', 'shipping', 'privacy', 'terms', 'custom'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const CONTACT_KINDS = [
  'phone',
  'whatsapp',
  'email',
  'website',
  'instagram',
  'facebook',
  'x',
  'tiktok',
  'linkedin',
  'other',
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
