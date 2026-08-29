-- Batched/throttled broadcast send: release recipients in waves of batch_size
-- every batch_interval_minutes. 0 = no batching (send all at once).
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "batch_size" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "batch_interval_minutes" INTEGER NOT NULL DEFAULT 0;
