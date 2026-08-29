-- Add 'cancelled' to CrawlJobStatus enum so the operator can stop a
-- running crawl from /bot. The worker polls this column between pages
-- and exits cleanly when it sees the cancellation.
ALTER TYPE "CrawlJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';
