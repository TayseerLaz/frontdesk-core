import { z } from 'zod';

// Channels the AI bot can answer on. WhatsApp is the original; Messenger +
// Instagram are Meta and share the Page Send API.
export const BOT_CHANNELS = ['whatsapp', 'messenger', 'instagram'] as const;
export type BotChannel = (typeof BOT_CHANNELS)[number];

// Upsert body for the Messenger/Instagram channel config. Credentials
// (pageAccessToken, appSecret) are write-only — send '' to clear, omit to
// leave unchanged. They're never returned.
export const upsertMessengerChannelBodySchema = z.object({
  pageId: z.string().trim().max(64).optional().nullable(),
  pageName: z.string().trim().max(200).optional().nullable(),
  igAccountId: z.string().trim().max(64).optional().nullable(),
  pageAccessToken: z.string().trim().max(4000).optional(),
  appSecret: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
});
export type UpsertMessengerChannelBody = z.infer<typeof upsertMessengerChannelBodySchema>;

// Response — non-secret config + has*/ready booleans + the webhook callback
// URL & verify token the operator pastes into the Meta app dashboard.
export const messengerChannelSchema = z.object({
  pageId: z.string().nullable(),
  pageName: z.string().nullable(),
  igAccountId: z.string().nullable(),
  hasPageAccessToken: z.boolean(),
  hasAppSecret: z.boolean(),
  isActive: z.boolean(),
  webhookVerifyToken: z.string(),
  webhookCallbackUrl: z.string(),
  ready: z.boolean(),
  lastVerifyStatus: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type MessengerChannelDto = z.infer<typeof messengerChannelSchema>;
