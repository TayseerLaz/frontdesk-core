-- HQ-only bot-eval runs (WS3 eval dashboard).
-- No organization_id / no RLS by design: an eval run spans every golden-set
-- tenant at once, so it is ALIGNED infrastructure surfaced on /hq,
-- never tenant-scoped data. The rls-drift gate only covers tables that carry
-- organization_id, so this table is correctly exempt.
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger" TEXT NOT NULL DEFAULT 'cli',
    "mode" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "passed" BOOLEAN NOT NULL,
    "tenant_count" INTEGER NOT NULL,
    "passed_count" INTEGER NOT NULL,
    "summaries" JSONB NOT NULL,
    "git_sha" TEXT,
    "note" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eval_runs_created_at_idx" ON "eval_runs" ("created_at" DESC);
