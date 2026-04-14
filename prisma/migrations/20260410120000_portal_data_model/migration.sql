-- ═══════════════════════════════════════════════════════════════════════════
-- CounselWorks Portal — Data Model
-- Additive migration. No drops. No renames on disk.
-- Prisma model renames are handled via @@map in schema.prisma
-- (Firm→LawFirm, Request→RequestThread, RequestMessage→ThreadMessage, File→Document).
--
-- New tables (11):
--   sla_profiles, clients, call_logs, leads, handoff_events, tasks,
--   medical_record_requests, checklist_items, draft_revisions, qa_reviews,
--   firm_assignments
--
-- Existing tables enriched (6):
--   users, cases, requests, request_messages, files, drafts
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── 1. users — add user_kind discriminator ─────────────────────────────────
-- Existing rows default to 'firm' (safer default for attorney portal).
-- CW internal staff will be updated to 'cw' by seed / backfill script.
ALTER TABLE "users"
  ADD COLUMN "user_kind"     TEXT NOT NULL DEFAULT 'firm',
  ADD COLUMN "internal_role" TEXT;


-- ─── 2. requests (Prisma RequestThread) ─────────────────────────────────────
ALTER TABLE "requests"
  ADD COLUMN "thread_kind"     TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN "priority"        TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "last_message_at" TIMESTAMPTZ,
  ADD COLUMN "resolved_by"     UUID;


-- ─── 3. request_messages (Prisma ThreadMessage) ─────────────────────────────
ALTER TABLE "request_messages"
  ADD COLUMN "message_kind" TEXT NOT NULL DEFAULT 'message',
  ADD COLUMN "read_at"      TIMESTAMPTZ,
  ADD COLUMN "attachments"  JSONB;


-- ─── 4. files (Prisma Document) ─────────────────────────────────────────────
-- case_id is a direct nullable FK in addition to the existing polymorphic
-- file_links mechanism, enabling fast per-case document queries.
ALTER TABLE "files"
  ADD COLUMN "case_id"                        UUID,
  ADD COLUMN "category"                       TEXT,
  ADD COLUMN "received_from"                  TEXT,
  ADD COLUMN "missing_from_checklist_item_id" UUID;


-- ─── 5. drafts — AI metadata ────────────────────────────────────────────────
ALTER TABLE "drafts"
  ADD COLUMN "confidence_score"   INTEGER,
  ADD COLUMN "disclaimer_variant" TEXT,
  ADD COLUMN "ai_model_used"      TEXT,
  ADD COLUMN "source_documents"   JSONB,
  ADD CONSTRAINT "drafts_confidence_score_check"
    CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100);


-- ═══════════════════════════════════════════════════════════════════════════
-- NEW TABLES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 6. sla_profiles ────────────────────────────────────────────────────────
-- Named SLA configs referenced by cases via sla_profile_id.
-- firms.sla_profile (JSONB) remains as-is; this is additive.
CREATE TABLE "sla_profiles" (
  "id"                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"              UUID        NOT NULL,
  "name"                 TEXT        NOT NULL,
  "description"          TEXT,
  "thread_response_hrs"  INTEGER     NOT NULL DEFAULT 24,
  "draft_turnaround_hrs" INTEGER     NOT NULL DEFAULT 72,
  "urgent_response_hrs"  INTEGER     NOT NULL DEFAULT 4,
  "config"               JSONB,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"          TIMESTAMPTZ,

  CONSTRAINT "sla_profiles_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "sla_profiles_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id")
);
CREATE INDEX "sla_profiles_firm_id_idx" ON "sla_profiles"("firm_id");


-- ─── 7. clients ─────────────────────────────────────────────────────────────
-- Decouples client identity from cases. Existing cases.client_name (TEXT) is
-- preserved; cases.client_id is added as a nullable FK below.
CREATE TABLE "clients" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"          UUID        NOT NULL,
  "full_name"        TEXT        NOT NULL,
  "email"            TEXT,
  "phone"            TEXT,
  "date_of_birth"    DATE,
  "date_of_incident" DATE,
  "address"          TEXT,
  "notes"            TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"      TIMESTAMPTZ,

  CONSTRAINT "clients_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "clients_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id")
);
CREATE INDEX "clients_firm_id_idx"           ON "clients"("firm_id");
CREATE INDEX "clients_firm_id_full_name_idx" ON "clients"("firm_id", "full_name");


-- ─── 8. cases — operational columns + FKs ───────────────────────────────────
ALTER TABLE "cases"
  ADD COLUMN "client_id"          UUID,
  ADD COLUMN "sla_profile_id"     UUID,
  ADD COLUMN "health_status"      TEXT NOT NULL DEFAULT 'on_track',
  ADD COLUMN "next_action"        TEXT,
  ADD COLUMN "next_action_due_at" TIMESTAMPTZ,
  ADD COLUMN "last_activity_at"   TIMESTAMPTZ;

ALTER TABLE "cases"
  ADD CONSTRAINT "cases_client_id_fkey"
    FOREIGN KEY ("client_id")      REFERENCES "clients"("id"),
  ADD CONSTRAINT "cases_sla_profile_id_fkey"
    FOREIGN KEY ("sla_profile_id") REFERENCES "sla_profiles"("id");

CREATE INDEX "cases_firm_health_status_idx"    ON "cases"("firm_id", "health_status");
CREATE INDEX "cases_client_id_idx"             ON "cases"("client_id");
CREATE INDEX "cases_firm_last_activity_at_idx" ON "cases"("firm_id", "last_activity_at" DESC);


-- ─── 9. files.case_id FK (now that cases columns are in place) ─────────────
ALTER TABLE "files"
  ADD CONSTRAINT "files_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id");
CREATE INDEX "files_case_id_idx"          ON "files"("case_id");
CREATE INDEX "files_firm_id_category_idx" ON "files"("firm_id", "category");


-- ─── 10. call_logs ──────────────────────────────────────────────────────────
-- converted_to_lead_id FK is attached AFTER leads table is created, below.
CREATE TABLE "call_logs" (
  "id"                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"              UUID        NOT NULL,
  "caller_name"          TEXT,
  "caller_phone"         TEXT,
  "call_type"            TEXT        NOT NULL DEFAULT 'inbound',
  "outcome"              TEXT,
  "notes"                TEXT,
  "handled_by"           UUID,
  "converted_to_lead_id" UUID,
  "called_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"          TIMESTAMPTZ,

  CONSTRAINT "call_logs_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "call_logs_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id")
);
CREATE INDEX "call_logs_firm_id_idx"           ON "call_logs"("firm_id");
CREATE INDEX "call_logs_firm_id_called_at_idx" ON "call_logs"("firm_id", "called_at" DESC);


-- ─── 11. leads ──────────────────────────────────────────────────────────────
CREATE TABLE "leads" (
  "id"                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"              UUID        NOT NULL,
  "client_id"            UUID,
  "source"               TEXT,
  "stage"                TEXT        NOT NULL DEFAULT 'new',
  "status"               TEXT        NOT NULL DEFAULT 'open',
  "assigned_to"          UUID,
  "sla_due_at"           TIMESTAMPTZ,
  "last_contact_at"      TIMESTAMPTZ,
  "notes"                TEXT,
  "converted_to_case_id" UUID,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"          TIMESTAMPTZ,

  CONSTRAINT "leads_pkey"                      PRIMARY KEY ("id"),
  CONSTRAINT "leads_firm_id_fkey"              FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "leads_client_id_fkey"            FOREIGN KEY ("client_id") REFERENCES "clients"("id"),
  CONSTRAINT "leads_converted_to_case_id_fkey" FOREIGN KEY ("converted_to_case_id") REFERENCES "cases"("id")
);
CREATE INDEX "leads_firm_id_idx"     ON "leads"("firm_id");
CREATE INDEX "leads_firm_stage_idx"  ON "leads"("firm_id", "stage");
CREATE INDEX "leads_assigned_to_idx" ON "leads"("assigned_to");

-- Wire call_logs.converted_to_lead_id now that leads exists
ALTER TABLE "call_logs"
  ADD CONSTRAINT "call_logs_converted_to_lead_id_fkey"
    FOREIGN KEY ("converted_to_lead_id") REFERENCES "leads"("id");


-- ─── 12. handoff_events ─────────────────────────────────────────────────────
CREATE TABLE "handoff_events" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"      UUID        NOT NULL,
  "case_id"      UUID        NOT NULL,
  "from_phase"   TEXT,
  "to_phase"     TEXT        NOT NULL,
  "triggered_by" UUID,
  "reason"       TEXT,
  "metadata"     JSONB,
  "occurred_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "handoff_events_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "handoff_events_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "handoff_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id")
);
CREATE INDEX "handoff_events_firm_id_idx"             ON "handoff_events"("firm_id");
CREATE INDEX "handoff_events_case_id_occurred_at_idx" ON "handoff_events"("case_id", "occurred_at" DESC);


-- ─── 13. tasks ──────────────────────────────────────────────────────────────
CREATE TABLE "tasks" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"      UUID        NOT NULL,
  "case_id"      UUID,
  "thread_id"    UUID,
  "title"        TEXT        NOT NULL,
  "description"  TEXT,
  "status"       TEXT        NOT NULL DEFAULT 'open',
  "priority"     TEXT        NOT NULL DEFAULT 'normal',
  "assigned_to"  UUID,
  "created_by"   UUID,
  "due_at"       TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"  TIMESTAMPTZ,

  CONSTRAINT "tasks_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "tasks_firm_id_fkey"   FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "tasks_case_id_fkey"   FOREIGN KEY ("case_id") REFERENCES "cases"("id"),
  CONSTRAINT "tasks_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "requests"("id")
);
CREATE INDEX "tasks_firm_id_idx"            ON "tasks"("firm_id");
CREATE INDEX "tasks_firm_status_idx"        ON "tasks"("firm_id", "status");
CREATE INDEX "tasks_assigned_to_status_idx" ON "tasks"("assigned_to", "status");
CREATE INDEX "tasks_firm_due_at_idx"        ON "tasks"("firm_id", "due_at");


-- ─── 14. medical_record_requests ────────────────────────────────────────────
CREATE TABLE "medical_record_requests" (
  "id"                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"               UUID        NOT NULL,
  "case_id"               UUID        NOT NULL,
  "provider_name"         TEXT        NOT NULL,
  "provider_address"      TEXT,
  "records_period_start"  DATE,
  "records_period_end"    DATE,
  "status"                TEXT        NOT NULL DEFAULT 'pending',
  "hitech_letter_sent_at" TIMESTAMPTZ,
  "records_received_at"   TIMESTAMPTZ,
  "cost_cents"            INTEGER,
  "notes"                 TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"           TIMESTAMPTZ,

  CONSTRAINT "medical_record_requests_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "medical_record_requests_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "medical_record_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id")
);
CREATE INDEX "medical_record_requests_firm_id_idx"     ON "medical_record_requests"("firm_id");
CREATE INDEX "medical_record_requests_case_id_idx"     ON "medical_record_requests"("case_id");
CREATE INDEX "medical_record_requests_firm_status_idx" ON "medical_record_requests"("firm_id", "status");


-- ─── 15. checklist_items ────────────────────────────────────────────────────
CREATE TABLE "checklist_items" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"        UUID        NOT NULL,
  "case_id"        UUID        NOT NULL,
  "checklist_type" TEXT        NOT NULL,
  "label"          TEXT        NOT NULL,
  "description"    TEXT,
  "status"         TEXT        NOT NULL DEFAULT 'pending',
  "required"       BOOLEAN     NOT NULL DEFAULT true,
  "sort_order"     INTEGER     NOT NULL DEFAULT 0,
  "due_at"         TIMESTAMPTZ,
  "completed_at"   TIMESTAMPTZ,
  "completed_by"   UUID,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"    TIMESTAMPTZ,

  CONSTRAINT "checklist_items_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "checklist_items_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "checklist_items_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id")
);
CREATE INDEX "checklist_items_firm_id_idx"                ON "checklist_items"("firm_id");
CREATE INDEX "checklist_items_case_id_idx"                ON "checklist_items"("case_id");
CREATE INDEX "checklist_items_case_id_checklist_type_idx" ON "checklist_items"("case_id", "checklist_type");

-- Wire files.missing_from_checklist_item_id now that checklist_items exists
ALTER TABLE "files"
  ADD CONSTRAINT "files_missing_from_checklist_item_id_fkey"
    FOREIGN KEY ("missing_from_checklist_item_id") REFERENCES "checklist_items"("id");


-- ─── 16. draft_revisions ────────────────────────────────────────────────────
CREATE TABLE "draft_revisions" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "draft_id"         UUID        NOT NULL,
  "version"          INTEGER     NOT NULL,
  "content_file_id"  UUID,
  "change_summary"   TEXT,
  "changed_by"       UUID,
  "generated_by_ai"  BOOLEAN     NOT NULL DEFAULT false,
  "confidence_score" INTEGER,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "draft_revisions_pkey"                 PRIMARY KEY ("id"),
  CONSTRAINT "draft_revisions_draft_id_fkey"        FOREIGN KEY ("draft_id")        REFERENCES "drafts"("id"),
  CONSTRAINT "draft_revisions_content_file_id_fkey" FOREIGN KEY ("content_file_id") REFERENCES "files"("id"),
  CONSTRAINT "draft_revisions_confidence_score_check"
    CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "draft_revisions_draft_id_version_key" ON "draft_revisions"("draft_id", "version");
CREATE INDEX        "draft_revisions_draft_id_idx"         ON "draft_revisions"("draft_id");


-- ─── 17. qa_reviews ─────────────────────────────────────────────────────────
CREATE TABLE "qa_reviews" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "draft_id"     UUID        NOT NULL,
  "reviewer_id"  UUID,
  "status"       TEXT        NOT NULL DEFAULT 'pending',
  "notes"        TEXT,
  "checklist"    JSONB,
  "started_at"   TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "qa_reviews_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "qa_reviews_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id")
);
CREATE INDEX "qa_reviews_draft_id_idx" ON "qa_reviews"("draft_id");
CREATE INDEX "qa_reviews_status_idx"   ON "qa_reviews"("status");


-- ─── 18. firm_assignments ───────────────────────────────────────────────────
-- CW-staff-to-firm pod assignments. Distinct from firm_memberships
-- (which stores firm-side user roles). Only applies when users.user_kind='cw'
-- (enforced at application layer, not DB).
CREATE TABLE "firm_assignments" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"       UUID        NOT NULL,
  "cw_user_id"    UUID        NOT NULL,
  "role"          TEXT        NOT NULL,
  "is_primary"    BOOLEAN     NOT NULL DEFAULT false,
  "assigned_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassigned_at" TIMESTAMPTZ,

  CONSTRAINT "firm_assignments_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "firm_assignments_firm_id_fkey"    FOREIGN KEY ("firm_id")    REFERENCES "firms"("id"),
  CONSTRAINT "firm_assignments_cw_user_id_fkey" FOREIGN KEY ("cw_user_id") REFERENCES "users"("id")
);
-- One assignment per (firm, user, role). Historical re-assignment is handled at
-- the application layer by updating unassigned_at back to NULL on the existing row.
CREATE UNIQUE INDEX "firm_assignments_firm_id_cw_user_id_role_key"
  ON "firm_assignments"("firm_id", "cw_user_id", "role");
CREATE INDEX "firm_assignments_firm_id_idx"    ON "firm_assignments"("firm_id");
CREATE INDEX "firm_assignments_cw_user_id_idx" ON "firm_assignments"("cw_user_id");


-- ═══════════════════════════════════════════════════════════════════════════
-- NEW INDEXES on existing tables for portal query patterns
-- ═══════════════════════════════════════════════════════════════════════════

-- Drafts inbox sort (newest first, filtered by firm + status)
CREATE INDEX "drafts_firm_status_created_at_idx"
  ON "drafts"("firm_id", "status", "created_at" DESC);

-- Morning-brief thread sort (most-recently-active first)
CREATE INDEX "requests_firm_last_message_at_idx"
  ON "requests"("firm_id", "last_message_at" DESC);
