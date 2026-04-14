-- ═══════════════════════════════════════════════════════════════════════════
-- CounselWorks Portal — Constraints & Triggers (defense-in-depth)
--
-- AUDIT OF THE THREE NON-NEGOTIABLE CONSTRAINTS CALLED OUT IN PROMPT 2:
--
--   [1] Draft delivery requires approval
--       CHECK (status <> 'delivered' OR approved_by IS NOT NULL)
--       → ALREADY APPLIED as "drafts_delivered_requires_approval"
--         in 20240105000000_add_drafts/migration.sql
--
--   [2] Draft label_text is fixed
--       CHECK (label_text = 'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.')
--       → ALREADY APPLIED as "drafts_label_text_check"
--         in 20240105000000_add_drafts/migration.sql
--
--   [3] ActivityLog rows are immutable (no UPDATE, no DELETE)
--       → ALREADY APPLIED as function prevent_activity_log_modification()
--         and trigger lock_activity_log (BEFORE UPDATE OR DELETE)
--         in 20240101000000_init/migration.sql
--
-- This migration adds only the ONE missing piece: a hard UPDATE trigger on
-- drafts.label_text. The existing CHECK constraint already makes it impossible
-- to store an invalid label value, so this trigger is strictly defense-in-depth:
-- it fails loud the instant any code path attempts to rewrite label_text (even
-- to the same value), preventing silent ORM-generated full-row UPDATEs from
-- masking a future schema drift (e.g. if the CHECK were ever dropped).
-- ═══════════════════════════════════════════════════════════════════════════


CREATE OR REPLACE FUNCTION prevent_draft_label_text_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.label_text IS DISTINCT FROM OLD.label_text THEN
    RAISE EXCEPTION
      'drafts.label_text is immutable. Attempted change on draft id=%. Required value: %',
      OLD.id, OLD.label_text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lock_draft_label_text ON drafts;

CREATE TRIGGER lock_draft_label_text
  BEFORE UPDATE OF label_text ON drafts
  FOR EACH ROW EXECUTE FUNCTION prevent_draft_label_text_change();
