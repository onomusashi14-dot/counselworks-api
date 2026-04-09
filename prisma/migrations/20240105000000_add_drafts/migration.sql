-- CreateTable: drafts
-- Every draft is a formal deliverable from CounselWorks to the attorney.
-- Non-negotiable constraints:
--   1. status = 'delivered' requires approved_by IS NOT NULL (DB-level)
--   2. label_text is fixed and cannot be changed — enforced by CHECK
CREATE TABLE "drafts" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"         UUID        NOT NULL,
  "case_id"         UUID        NOT NULL,
  "request_id"      UUID,
  "file_id"         UUID,
  "draft_type"      TEXT        NOT NULL,
  "version"         INTEGER     NOT NULL DEFAULT 1,
  "status"          TEXT        NOT NULL DEFAULT 'drafted',
  "label_text"      TEXT        NOT NULL DEFAULT 'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.',
  "generated_by_ai" BOOLEAN     NOT NULL DEFAULT false,
  "reviewed_by"     UUID,
  "approved_by"     UUID,
  "notes"           TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at"    TIMESTAMPTZ,
  "archived_at"     TIMESTAMPTZ,

  CONSTRAINT "drafts_pkey"              PRIMARY KEY ("id"),
  CONSTRAINT "drafts_firm_id_fkey"      FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "drafts_case_id_fkey"      FOREIGN KEY ("case_id") REFERENCES "cases"("id"),
  CONSTRAINT "drafts_request_id_fkey"   FOREIGN KEY ("request_id") REFERENCES "requests"("id"),
  CONSTRAINT "drafts_file_id_fkey"      FOREIGN KEY ("file_id") REFERENCES "files"("id"),

  CONSTRAINT "drafts_type_check"        CHECK (draft_type IN (
    'demand_letter', 'medical_summary', 'chronology',
    'case_fact_sheet', 'client_communication',
    'provider_communication', 'declaration_shell', 'other'
  )),
  CONSTRAINT "drafts_status_check"      CHECK (status IN (
    'drafted', 'in_review', 'needs_revision', 'approved', 'delivered'
  )),

  -- THE NON-NEGOTIABLE CONSTRAINT:
  -- A draft cannot be delivered without an approver.
  -- Enforced at DB level AND application level — both gates must hold.
  CONSTRAINT "drafts_delivered_requires_approval"
    CHECK (status != 'delivered' OR approved_by IS NOT NULL),

  -- label_text cannot be changed from the standard value
  CONSTRAINT "drafts_label_text_check"
    CHECK (label_text = 'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.')
);

CREATE INDEX "drafts_firm_id_idx"        ON "drafts"("firm_id");
CREATE INDEX "drafts_case_id_idx"        ON "drafts"("case_id");
CREATE INDEX "drafts_firm_status_idx"    ON "drafts"("firm_id", "status");
CREATE INDEX "drafts_firm_delivered_idx" ON "drafts"("firm_id", "delivered_at")
  WHERE status = 'delivered';
