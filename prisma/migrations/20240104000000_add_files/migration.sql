-- CreateTable: files
-- storageKey is the S3 object key — internal only, never returned to clients
CREATE TABLE "files" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"       UUID        NOT NULL,
  "uploaded_by"   UUID,
  "original_name" TEXT        NOT NULL,
  "storage_key"   TEXT        NOT NULL,         -- S3 key: {firmId}/{entityType}/{entityId}/{uuid}-{name}
  "mime_type"     TEXT        NOT NULL,
  "size_bytes"    BIGINT      NOT NULL,
  "document_type" TEXT        NOT NULL DEFAULT 'other',
  "status"        TEXT        NOT NULL DEFAULT 'pending',
  "review_status" TEXT        NOT NULL DEFAULT 'unreviewed',
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"   TIMESTAMPTZ,

  CONSTRAINT "files_pkey"                PRIMARY KEY ("id"),
  CONSTRAINT "files_firm_id_fkey"        FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "files_storage_key_key"     UNIQUE ("storage_key"),
  CONSTRAINT "files_status_check"        CHECK (status IN ('pending', 'ready', 'archived')),
  CONSTRAINT "files_review_status_check" CHECK (review_status IN ('unreviewed', 'reviewed', 'flagged', 'approved')),
  CONSTRAINT "files_document_type_check" CHECK (document_type IN (
    'id', 'insurance', 'police_report', 'medical_record', 'billing_record',
    'photo', 'retainer', 'demand_draft', 'medical_summary', 'chronology',
    'carrier_correspondence', 'other'
  )),
  CONSTRAINT "files_mime_type_check" CHECK (mime_type IN (
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  )),
  CONSTRAINT "files_size_check" CHECK (size_bytes > 0 AND size_bytes <= 26214400)  -- max 25MB
);

CREATE INDEX "files_firm_id_idx"      ON "files"("firm_id");
CREATE INDEX "files_firm_type_idx"    ON "files"("firm_id", "document_type");
CREATE INDEX "files_firm_status_idx"  ON "files"("firm_id", "status");

-- CreateTable: file_links (polymorphic join)
CREATE TABLE "file_links" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"     UUID        NOT NULL,
  "file_id"     UUID        NOT NULL,
  "entity_type" TEXT        NOT NULL,
  "entity_id"   UUID        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "file_links_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "file_links_firm_id_fkey"  FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "file_links_file_id_fkey"  FOREIGN KEY ("file_id") REFERENCES "files"("id"),
  CONSTRAINT "file_links_entity_check"  CHECK (entity_type IN ('case', 'request', 'message')),
  CONSTRAINT "file_links_unique"        UNIQUE ("file_id", "entity_type", "entity_id")
);

CREATE INDEX "file_links_entity_idx"   ON "file_links"("firm_id", "entity_type", "entity_id");

-- Cleanup job index: find pending files older than 2 hours
CREATE INDEX "files_pending_created_idx" ON "files"("status", "created_at")
  WHERE status = 'pending';
