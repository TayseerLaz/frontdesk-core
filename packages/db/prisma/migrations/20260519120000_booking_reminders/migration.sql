-- Booking reminders.
--
-- Adds three columns to bookings so each row can carry the operator's
-- per-booking reminder choice and the tick worker can find due reminders:
--   * appointment_at        — resolved appointment timestamp (UTC).
--   * reminder_template_id  — operator-picked, pre-approved WhatsApp
--                              template. NULL = reminder disabled.
--   * reminder_sent_at      — stamped by the tick after a successful Meta
--                              send so we never fire twice.
--
-- Plus a partial-style composite index so the worker's "is anything due
-- right now?" scan is O(small).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS appointment_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_template_id  UUID,
  ADD COLUMN IF NOT EXISTS reminder_sent_at      TIMESTAMPTZ;

-- ON DELETE SET NULL: if the operator deletes the template that was
-- linked here, leave the booking around but blank the reminder so the
-- tick doesn't trip over a dangling FK.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_reminder_template_id_fkey;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_reminder_template_id_fkey
    FOREIGN KEY (reminder_template_id) REFERENCES whatsapp_templates(id)
    ON DELETE SET NULL;

-- Tick worker query shape:
--   WHERE status = 'confirmed'
--     AND reminder_template_id IS NOT NULL
--     AND reminder_sent_at IS NULL
--     AND appointment_at BETWEEN now()+1h55m AND now()+2h5m
CREATE INDEX IF NOT EXISTS bookings_reminder_due_idx
  ON bookings (status, reminder_sent_at, appointment_at);

-- New webhook event kind so integrations can subscribe to reminder fires.
ALTER TYPE "WebhookEventKind" ADD VALUE IF NOT EXISTS 'booking_reminder_sent';
