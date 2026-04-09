-- CreateTable: refresh_tokens
-- Stores hashed refresh tokens, one row per active session.
-- Raw token is NEVER stored — only bcrypt hash.
-- On logout: row is deleted (token cannot be reused).
-- On refresh: hash incoming token, compare to stored hash.
-- Rotation: each refresh deletes old row and inserts new one.
CREATE TABLE "refresh_tokens" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL,
  "token_hash" TEXT        NOT NULL,         -- bcrypt hash of raw token
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey"         PRIMARY KEY ("id"),
  CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id")
);

-- Index for fast lookup by user (revoke all sessions)
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- Cleanup index: expired tokens
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens"("expires_at")
  WHERE expires_at < NOW();
