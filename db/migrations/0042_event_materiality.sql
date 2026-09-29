-- 0042_event_materiality.sql — R7.1d.2: durable event-materiality pipeline.
--
-- R7.1d.2 IS SHADOW DATA. DO NOT USE FOR USER-FACING RANKING.
-- Event materiality is a PROJECTION of claim_materiality_current via
-- aggregateClaimsToEvent() — never a second truth system, never a
-- re-score of event text. The benchmark has measured the honest
-- transmission quality (driver recall 0.43, target recall 0.39, scope
-- 0.50, 8/9 high-FP from upstream mis-clustering): good enough to
-- persist for observation, NOT good enough to rank Radar.
--
-- Two tables, no new queue — the event worker consumes the existing
-- dirty_events queue under job='event_materiality', dirtied by
-- publishClaimAssessment in the same transaction as a claim projection
-- change.
--
--   event_materiality_assessments — APPEND-ONLY history. One row per
--     (event_id, method_version, input_hash). input_hash covers ONLY
--     the sorted (claim_id, claim_assessment_id) pairs — the semantic
--     input set. Event title/topic/timestamps/queue metadata/run ids
--     are deliberately excluded: a headline edit that changes no claim
--     assessment does not mint a new event assessment.
--
--   event_materiality_current — the mutable projection. CAS on
--     source_generation: a stale worker can never downgrade a newer
--     generation's result.
--
-- RLS enabled with NO anon/authenticated policies — pipeline internals.

CREATE TABLE event_materiality_assessments (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id                uuid        NOT NULL REFERENCES events(id),
  input_hash              text        NOT NULL,
  input_snapshot          jsonb       NOT NULL,
  method                  text        NOT NULL,
  method_version          text        NOT NULL,
  intrinsic_materiality   text        NOT NULL,
  scope                   text,
  confidence              text,
  channels                jsonb       NOT NULL,
  affected_targets        jsonb       NOT NULL,
  driver_claim_ids        jsonb       NOT NULL,
  contributing_claim_ids  jsonb       NOT NULL,
  claim_assessment_ids    jsonb       NOT NULL,
  coverage                jsonb       NOT NULL,
  cautions                jsonb       NOT NULL,
  assessment              jsonb       NOT NULL,
  assessed_at             timestamptz NOT NULL DEFAULT now(),
  -- same claim-assessment set + same method ⇒ same assessment — a
  -- retry or replay reuses, never duplicates
  UNIQUE (event_id, method_version, input_hash)
);
CREATE INDEX idx_event_mat_assess_event
  ON event_materiality_assessments (event_id, assessed_at DESC);

CREATE TABLE event_materiality_current (
  event_id          uuid PRIMARY KEY REFERENCES events(id),
  assessment_id     uuid        NOT NULL REFERENCES event_materiality_assessments(id),
  input_hash        text        NOT NULL,
  method_version    text        NOT NULL,
  -- the dirty_events generation this projection was built from
  source_generation bigint      NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- == PG-ONLY: append-only + RLS (plpgsql — skipped by pg-mem tests) ==
CREATE TRIGGER event_materiality_assessments_append_only
  BEFORE UPDATE OR DELETE ON event_materiality_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE event_materiality_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_materiality_current    ENABLE ROW LEVEL SECURITY;

COMMIT;
