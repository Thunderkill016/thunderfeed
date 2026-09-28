-- 0038_r6_1b_path_invariant_truth.sql — R6.1b: path-invariant evidence truth.
--
--   claim_change_type gains 'recomputed': when provenance changes under a
--   mutable state (e.g. two "independent" origins relineage-collapse into
--   one Reuters root), the standing claim mints a new version reflecting
--   the recomputed truth — supported → reported is a state correction,
--   not a value change and not a dispute.
--
--   job_runs.status gains 'partial': a run that finished its sweep with
--   per-event failures is neither 'done' nor wholesale 'failed' — it
--   completed bounded work, and its cursor only covers the contiguous
--   successful prefix.

ALTER TYPE claim_change_type ADD VALUE 'recomputed';

-- the inline CHECK from 0037 is 'job_runs_status_check' on Postgres;
-- pg-mem auto-names it differently - drop both forms defensively
ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_status_check;
ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_constraint_1;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_status_check
  CHECK (status IN ('running','done','partial','failed'));
