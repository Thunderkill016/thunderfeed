-- 0028_data_deltas.sql — the data-layer delta feed.
--
-- `changes` tracks claim/event truth-state transitions (news-driven).
-- `data_deltas` tracks canonical DATA transitions: a macro series got a
-- new observation or a revision, a corporate action was declared or its
-- canonical state was corrected. Same append-only contract: a delta row
-- asserts "at detected_at we learned this", never rewritten.
--
-- Subject discipline: exactly one typed FK is set per row, and each
-- subject's version pointers must match its type — enforced by CHECKs so
-- a delta can never point across subjects.

BEGIN;

CREATE TABLE data_deltas (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  kind                   text NOT NULL CHECK (kind IN (
                           'macro_release', 'macro_revision',
                           'ca_declared', 'ca_updated')),
  materiality            materiality NOT NULL DEFAULT 'low',
  summary                text NOT NULL,
  -- exactly one subject
  point_id               uuid REFERENCES macro_points(id),
  action_id              uuid REFERENCES corporate_actions(id),
  -- the version this delta produced + the one it superseded
  macro_version_id       uuid REFERENCES macro_point_versions(id),
  prev_macro_version_id  uuid REFERENCES macro_point_versions(id),
  action_version_id      uuid REFERENCES corporate_action_versions(id),
  prev_action_version_id uuid REFERENCES corporate_action_versions(id),
  detected_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((point_id IS NULL) <> (action_id IS NULL)),
  CHECK ((point_id IS NULL) = (macro_version_id IS NULL)),
  CHECK ((action_id IS NULL) = (action_version_id IS NULL)),
  -- one delta per produced version — rerun/dedupe can never double-emit
  UNIQUE (macro_version_id),
  UNIQUE (action_version_id)
);

CREATE INDEX idx_data_deltas_detected ON data_deltas (detected_at DESC);
CREATE INDEX idx_data_deltas_kind ON data_deltas (kind);
CREATE INDEX idx_data_deltas_point ON data_deltas (point_id);
CREATE INDEX idx_data_deltas_action ON data_deltas (action_id);

-- == PG-ONLY: security posture + append-only invariants ====================

ALTER TABLE data_deltas ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE data_deltas FROM anon, authenticated;

CREATE TRIGGER trg_data_deltas_immutable
  BEFORE UPDATE OR DELETE ON data_deltas
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
