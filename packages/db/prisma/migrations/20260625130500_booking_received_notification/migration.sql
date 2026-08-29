-- Voice/chat bookings emit a bell notification (voice has no inbox thread, so
-- the notification is the operator's only surface for a phone booking). Add the
-- dedicated NotificationKind value. Separate migration so the ALTER TYPE ADD
-- VALUE runs on its own (Postgres won't let a freshly-added enum value be used
-- in the same transaction that adds it).
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'booking_received';
