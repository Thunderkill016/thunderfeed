-- 0006: information lineage hardening.
-- - classifier_version + supersedes_lineage_id make every reclassification
--   auditable end-to-end (which rules fired, which row it replaces).
-- - evidence_lineage / evidence_metadata_observations become truly
--   append-only: UPDATE and DELETE are rejected at the database level.
--   Corrections always insert a new version/observation.

ALTER TABLE evidence_lineage
  ADD COLUMN classifier_version text NOT NULL DEFAULT 'v1';
ALTER TABLE evidence_lineage
  ADD COLUMN supersedes_lineage_id uuid REFERENCES evidence_lineage(id);
CREATE INDEX idx_lineage_supersedes ON evidence_lineage (supersedes_lineage_id)
  WHERE supersedes_lineage_id IS NOT NULL;

-- == PG-ONLY: append-only triggers (plpgsql — skipped by pg-mem tests) ==
CREATE TRIGGER evidence_lineage_append_only
  BEFORE UPDATE OR DELETE ON evidence_lineage
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER evidence_metadata_observations_append_only
  BEFORE UPDATE OR DELETE ON evidence_metadata_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
