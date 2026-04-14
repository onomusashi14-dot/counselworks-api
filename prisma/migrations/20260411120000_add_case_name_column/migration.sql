-- ═══════════════════════════════════════════════════════════════════════════
-- Add adversarial case name column
-- Stores the proper caption for a matter (e.g. "Garcia v. Metro Transit").
-- Nullable because existing rows seeded before this migration have no value;
-- the backend falls back to "clientName — humanized caseType" when NULL.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "cases"
  ADD COLUMN "case_name" TEXT;
