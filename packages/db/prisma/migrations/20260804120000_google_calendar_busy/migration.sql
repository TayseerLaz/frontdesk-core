-- Google Calendar two-way: read the connected calendar so its events can be
-- shown in Hader's booking calendar and (optionally) block booking slots.
--
-- Additive column on an existing RLS table — no new table, no policy change.
-- Defaults true: the only behaviour a connected tenant sees is that slots they
-- are already busy for stop being offered, which is the point of the feature.
ALTER TABLE "google_calendar_connections"
    ADD COLUMN "block_on_busy" BOOLEAN NOT NULL DEFAULT true;
