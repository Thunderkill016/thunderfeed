-- 0037_r6_1_evidence_correction.sql — R6.1: one evidence model, exact
-- claim-state semantics, derived-assessment provenance, job visibility.
--
--   claim_change_type gains 'supported' / 'unresolved' — the R6 batch
--   adjudicator minted 'supported' under change_type='confirmed', which
--   made the audit log claim authority confirmation that never happened.
--   supported = ≥2 independent origins; confirmed = primary only.
--
--   change_type gains 'claim_supported' for the changes ledger row.
--
--   event_entities gains provenance for the derived prominence/role —
--   a derived assessment must say who computed it and from what.
--
--   job_runs — cron observability: cursor watermark, processed/failed,
--   error. Replaces "rerun is probably idempotent" as the reliability
--   story.
--
--   evidence_documents.independence_key (0036) is DEPRECATED: per-event
--   clustering wrote iteration-order-dependent values into a global
--   column. Canonical independence = evidence_lineage effective roots
--   (lib/db/read.ts effectiveRoots). Column kept for audit; no writer.

-- no IF NOT EXISTS: pg-mem (test schema loader) can't parse it, and
-- schema_migrations already makes re-runs impossible on real Postgres.
ALTER TYPE claim_change_type ADD VALUE 'supported';
ALTER TYPE claim_change_type ADD VALUE 'unresolved';
ALTER TYPE change_type ADD VALUE 'claim_supported';

COMMENT ON COLUMN evidence_documents.independence_key IS 'DEPRECATED (R6.1): per-event title-shingle clustering is not a document-global property. Canonical independence lives in evidence_lineage effective roots.';

ALTER TABLE event_entities
  ADD COLUMN IF NOT EXISTS prominence_method text,
  ADD COLUMN IF NOT EXISTS prominence_evidence jsonb;

CREATE TABLE IF NOT EXISTS job_runs (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  job         text NOT NULL,
  status      text NOT NULL CHECK (status IN ('running','done','failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cursor_ts   timestamptz,            -- watermark: process events after this
  processed   int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  error       text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_time
  ON job_runs (job, started_at DESC);
