-- Booking → Google Calendar → meeting link.
--
-- Three per-tenant settings on the existing connection row. Additive columns on
-- an RLS-enabled table, so the existing per-row policy already covers them.
--
-- Defaults are chosen so that connecting a calendar behaves as it does today
-- for anyone already connected, EXCEPT that bookings now auto-confirm — which
-- is the behaviour that was asked for and is only reachable with a calendar
-- attached.
ALTER TABLE "google_calendar_connections"
    -- Whether bookings are written to the calendar at all. Off = bookings stay
    -- in Hader; no event, no meeting link, no invitation.
    ADD COLUMN "push_bookings" BOOLEAN NOT NULL DEFAULT true,
    -- 'online'  → the event carries a Google Meet link, sent to the customer.
    -- 'onsite'  → no Meet link; the customer is sent the business address.
    -- Defaults to 'onsite': telling a customer to "join the video call" for a
    -- business that meets in person is a worse failure than omitting a link,
    -- so the video behaviour is opt-in.
    ADD COLUMN "meeting_mode" TEXT NOT NULL DEFAULT 'onsite',
    -- Whether the bot confirms a booking itself instead of leaving it for a
    -- human. Confirming inside the conversation is what keeps the customer's
    -- message inside WhatsApp's 24-hour window, so no Meta template is needed.
    ADD COLUMN "auto_confirm" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "google_calendar_connections"
    ADD CONSTRAINT "google_calendar_connections_meeting_mode_check"
    CHECK ("meeting_mode" IN ('online', 'onsite'));
