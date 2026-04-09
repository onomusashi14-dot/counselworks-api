-- CreateTable: firms
CREATE TABLE "firms" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'active',
  "sla_profile" JSONB,
  "timezone"    TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMPTZ,
  CONSTRAINT "firms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "firms_slug_key" ON "firms"("slug");

-- CreateTable: users
CREATE TABLE "users" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "auth_id"        TEXT NOT NULL,
  "email"          TEXT NOT NULL,
  "full_name"      TEXT NOT NULL,
  "phone"          TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_active_at" TIMESTAMPTZ,
  "archived_at"    TIMESTAMPTZ,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_auth_id_key" ON "users"("auth_id");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateTable: firm_memberships
CREATE TABLE "firm_memberships" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"     UUID NOT NULL,
  "user_id"     UUID NOT NULL,
  "role"        TEXT NOT NULL,
  "is_primary"  BOOLEAN NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMPTZ,
  CONSTRAINT "firm_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "firm_memberships_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id"),
  CONSTRAINT "firm_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id")
);
CREATE UNIQUE INDEX "firm_memberships_firm_id_user_id_key" ON "firm_memberships"("firm_id","user_id");

-- CreateTable: activity_log
CREATE TABLE "activity_log" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "firm_id"       UUID,
  "actor_id"      UUID,
  "actor_type"    TEXT NOT NULL,
  "entity_type"   TEXT NOT NULL,
  "entity_id"     UUID NOT NULL,
  "activity_type" TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "ip_address"    INET,
  "metadata"      JSONB,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- ─── ACTIVITY LOG IMMUTABILITY TRIGGER ────────────────────────────────────────
-- Applied in this migration — NOT a manual step.
-- Prevents any UPDATE or DELETE on activity_log rows.
-- Ensures audit trail is permanent and tamper-proof.
CREATE OR REPLACE FUNCTION prevent_activity_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'activity_log rows are immutable. Attempted % on id=%. All audit entries are permanent.',
    TG_OP, OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_activity_log
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION prevent_activity_log_modification();
