-- 0041_claim_materiality.sql — R7.1c: durable claim-materiality pipeline.
--
-- Three structures, none touching `claims`:
--
--   claim_materiality_assessments — APPEND-ONLY history. One row per
--     (claim_id, claim_version_id, method_version, input_hash). The
--     input_snapshot records exactly what was scored so any assessment
--     can be audited against the truth/provenance that produced it.
--     input_hash is a semantic hash of the normalized scorer input —
--     timestamps, queue metadata and run ids are never part of it, so
--     identical input under a different generation dedupes to the same
--     assessment. input_snapshot holds the exact canonical
--     ClaimMaterialityInput: current truth, standing provenance stats,
--     subject inputs, economicComparison.
--
--   claim_materiality_current — the mutable projection. A current
--     pointer, not a second truth: it may UPDATE, but a lower
--     source_generation can never overwrite a higher one.
--
--   dirty_claims — durable producer→consumer queue carrying generation
--     from day one (the R6.1c→d fix applied at birth): a re-enqueue
--     bumps generation, so a consumer's generation-bound ack can never
--     retire work it never saw.
--
-- RLS enabled with NO anon/authenticated policies — R7.1c is pipeline
-- internals; nothing reads these from the browser yet.

CREATE TABLE claim_materiality_assessments (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  claim_id                uuid        NOT NULL REFERENCES claims(id),
  claim_version_id        uuid        NOT NULL REFERENCES claim_versions(id),
  input_hash              text        NOT NULL,
  input_snapshot          jsonb       NOT NULL,
  method                  text        NOT NULL,
  method_version          text        NOT NULL,
  action_type             text        NOT NULL,
  intrinsic_materiality   text        NOT NULL,
  scope                   text,
  transmission_confidence text,
  excluded                boolean     NOT NULL DEFAULT false,
  assessment              jsonb       NOT NULL,
  assessed_at             timestamptz NOT NULL DEFAULT now(),
  -- same claim version + same method + same semantic input ⇒ same
  -- assessment — a retry or replay reuses, never duplicates
  UNIQUE (claim_id, claim_version_id, method_version, input_hash)
);
CREATE INDEX idx_claim_mat_assess_claim
  ON claim_materiality_assessments (claim_id, assessed_at DESC);

CREATE TABLE claim_materiality_current (
  claim_id          uuid PRIMARY KEY REFERENCES claims(id),
  assessment_id     uuid        NOT NULL REFERENCES claim_materiality_assessments(id),
  claim_version_id  uuid        NOT NULL REFERENCES claim_versions(id),
  input_hash        text        NOT NULL,
  method_version    text        NOT NULL,
  -- the dirty_claims generation this projection was built from — a
  -- stale worker must never overwrite a newer generation's result
  source_generation bigint      NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dirty_claims (
  claim_id     uuid        NOT NULL REFERENCES claims(id),
  job          text        NOT NULL,   -- consumer: 'materiality' | ...
  reason       text        NOT NULL,   -- producer: 'ingest' | 'adjudicate' | 'relineage'
  generation   bigint      NOT NULL DEFAULT 1,
  queued_at    timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,            -- NULL = pending
  PRIMARY KEY (claim_id, job)
);
CREATE INDEX idx_dirty_claims_pending ON dirty_claims (job, processed_at);

-- == PG-ONLY: append-only + RLS (plpgsql — skipped by pg-mem tests) ==
CREATE TRIGGER claim_materiality_assessments_append_only
  BEFORE UPDATE OR DELETE ON claim_materiality_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE claim_materiality_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_materiality_current    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dirty_claims                 ENABLE ROW LEVEL SECURITY;

COMMIT;
