-- CreateTable: requests
CREATE TABLE "requests" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"      UUID        NOT NULL,
  "case_id"      UUID,
  "created_by"   UUID        NOT NULL,
  "assigned_to"  UUID,                    -- nullable: Option B, assigned later by CW
  "subject"      TEXT        NOT NULL,
  "request_type" TEXT        NOT NULL DEFAULT 'general',
  "status"       TEXT        NOT NULL DEFAULT 'open',
  "sla_due_at"   TIMESTAMPTZ,
  "eta"          TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"    TIMESTAMPTZ,

  CONSTRAINT "requests_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "requests_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id"),
  CONSTRAINT "requests_type_check"   CHECK (request_type IN (
    'draft_request','status_update','document_chase',
    'records_summary','chronology','general'
  )),
  CONSTRAINT "requests_status_check" CHECK (status IN (
    'open','in_progress','pending_attorney','completed','closed'
  ))
);

CREATE INDEX "requests_firm_id_idx"       ON "requests"("firm_id");
CREATE INDEX "requests_firm_status_idx"   ON "requests"("firm_id", "status");
CREATE INDEX "requests_firm_assigned_idx" ON "requests"("firm_id", "assigned_to");

-- CreateTable: request_messages
CREATE TABLE "request_messages" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "request_id"       UUID        NOT NULL,
  "firm_id"          UUID        NOT NULL,
  "sender_id"        UUID,
  "sender_type"      TEXT        NOT NULL,
  "body"             TEXT        NOT NULL,
  "is_draft_delivery" BOOLEAN    NOT NULL DEFAULT false,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "request_messages_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "request_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id"),
  CONSTRAINT "request_messages_sender_type_check" CHECK (sender_type IN (
    'attorney','firm_staff','counselworks_staff','system'
  ))
);

CREATE INDEX "request_messages_request_id_idx" ON "request_messages"("request_id");
CREATE INDEX "request_messages_firm_id_idx"    ON "request_messages"("firm_id");

-- CreateTable: notifications
CREATE TABLE "notifications" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"     UUID,
  "user_id"     UUID        NOT NULL,
  "type"        TEXT        NOT NULL,
  "title"       TEXT        NOT NULL,
  "body"        TEXT        NOT NULL,
  "entity_type" TEXT,
  "entity_id"   UUID,
  "read_at"     TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "notifications_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id")
);

CREATE INDEX "notifications_user_read_idx"    ON "notifications"("user_id", "read_at");
CREATE INDEX "notifications_user_created_idx" ON "notifications"("user_id", "created_at" DESC);
