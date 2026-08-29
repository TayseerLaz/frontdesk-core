-- Phase 2 — AI bot builder.

CREATE TYPE "CrawlJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'partial', 'failed');

CREATE TABLE "bot_configs" (
    "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"       UUID NOT NULL UNIQUE,
    "personality"           TEXT,
    "custom_personality"    TEXT,
    "detected_tone"         TEXT,
    "greeting"              TEXT,
    "languages"             TEXT NOT NULL DEFAULT 'en',
    "escalation_rules"      JSONB,
    "conversation_flow"     JSONB,
    "response_templates"    JSONB,
    "deployed_at"           TIMESTAMP(3),
    "version"               INT NOT NULL DEFAULT 1,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bot_configs_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "crawl_jobs" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "root_url"          TEXT NOT NULL,
    "status"            "CrawlJobStatus" NOT NULL DEFAULT 'pending',
    "max_pages"         INT NOT NULL DEFAULT 30,
    "max_depth"         INT NOT NULL DEFAULT 2,
    "pages_crawled"     INT NOT NULL DEFAULT 0,
    "pages_failed"      INT NOT NULL DEFAULT 0,
    "error_message"     TEXT,
    "started_at"        TIMESTAMP(3),
    "finished_at"       TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "crawl_jobs_org_created_idx"
    ON "crawl_jobs" ("organization_id", "created_at" DESC);

CREATE TABLE "crawl_pages" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "crawl_job_id"      UUID NOT NULL,
    "url"               TEXT NOT NULL,
    "title"             TEXT,
    "body_text"         TEXT,
    "fetch_status"      INT,
    "error_message"     TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crawl_pages_job_fk"
        FOREIGN KEY ("crawl_job_id") REFERENCES "crawl_jobs"("id") ON DELETE CASCADE
);
CREATE INDEX "crawl_pages_job_idx" ON "crawl_pages" ("crawl_job_id");

CREATE TABLE "knowledge_base_entries" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "kind"              TEXT NOT NULL,
    "question"          TEXT NOT NULL,
    "answer"            TEXT NOT NULL,
    "source_url"        TEXT,
    "source_type"       TEXT NOT NULL DEFAULT 'ai',
    "approved"          BOOLEAN NOT NULL DEFAULT FALSE,
    "search_text"       TEXT NOT NULL DEFAULT '',
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL
);
CREATE INDEX "kb_entries_org_kind_idx"     ON "knowledge_base_entries" ("organization_id", "kind");
CREATE INDEX "kb_entries_org_approved_idx" ON "knowledge_base_entries" ("organization_id", "approved");
CREATE INDEX "kb_entries_search_trgm_idx"
    ON "knowledge_base_entries" USING gin ("search_text" gin_trgm_ops);

CREATE TABLE "bot_test_runs" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "scenario_key"      TEXT NOT NULL,
    "scenario_prompt"   TEXT NOT NULL,
    "bot_response"      TEXT NOT NULL,
    "score"             INT,
    "judge_notes"       TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "bot_test_runs_org_scenario_idx"
    ON "bot_test_runs" ("organization_id", "scenario_key", "created_at" DESC);

CREATE TABLE "bot_simulation_turns" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID NOT NULL,
    "session_id"        TEXT NOT NULL,
    "role"              TEXT NOT NULL,
    "body"              TEXT NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "bot_simulation_turns_org_session_idx"
    ON "bot_simulation_turns" ("organization_id", "session_id", "created_at");
