-- Adds previous_token_rotated_at so the refresh handler can grant a small
-- replay-grace window for concurrent same-tab refresh races (SessionProvider
-- bootstrap + a useQuery's 401-retry both firing on a hard reload). Without
-- the window, ANY second /auth/refresh that arrives after rotation but
-- before the browser commits the new cookie trips reuse-detection and
-- revokes the session — the "hard refresh logs me out" bug.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS previous_token_rotated_at TIMESTAMP(3) WITH TIME ZONE;
