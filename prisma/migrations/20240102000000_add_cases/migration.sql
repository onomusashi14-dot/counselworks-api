-- CreateTable: cases
CREATE TABLE "cases" (
  "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"             UUID        NOT NULL,
  "matter_number"       TEXT        NOT NULL,
  "client_name"         TEXT        NOT NULL,
  "case_type"           TEXT        NOT NULL,
  "jurisdiction"        TEXT        NOT NULL DEFAULT 'CA',
  "phase"               TEXT        NOT NULL DEFAULT 'intake',
  "status"              TEXT        NOT NULL DEFAULT 'active',
  "readiness_score"     INTEGER     NOT NULL DEFAULT 0,
  "health_summary"      TEXT,
  "assigned_cw_user_id" UUID,
  "primary_attorney_id" UUID,
  "opened_date"         DATE        NOT NULL DEFAULT CURRENT_DATE,
  "priority"            TEXT        NOT NULL DEFAULT 'normal',
  "notes"               TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"         TIMESTAMPTZ,

  CONSTRAINT "cases_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "cases_firm_id_fkey"   FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "cases_matter_number_key" UNIQUE ("matter_number"),
  CONSTRAINT "cases_phase_check"    CHECK (phase IN (
    'intake','administration','records_collection',
    'demand_prep','negotiation','litigation_prep','litigation','resolved'
  )),
  CONSTRAINT "cases_status_check"   CHECK (status IN (
    'active','on_hold','closed','settled','archived'
  )),
  CONSTRAINT "cases_priority_check" CHECK (priority IN ('normal','high','urgent')),
  CONSTRAINT "cases_readiness_check" CHECK (readiness_score BETWEEN 0 AND 100)
);

CREATE INDEX "cases_firm_id_idx"     ON "cases"("firm_id");
CREATE INDEX "cases_firm_status_idx" ON "cases"("firm_id", "status");
CREATE INDEX "cases_firm_phase_idx"  ON "cases"("firm_id", "phase");

-- Activity log query indexes (added here since they depend on the table existing)
CREATE INDEX IF NOT EXISTS "activity_log_firm_id_idx"    ON "activity_log"("firm_id");
CREATE INDEX IF NOT EXISTS "activity_log_entity_idx"     ON "activity_log"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "activity_log_created_at_idx" ON "activity_log"("created_at" DESC);
