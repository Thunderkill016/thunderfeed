BEGIN;

-- 0024: Market Data V1.1 — referential integrity + DB-level invariants.
--
--   (a) market_points.current_version_id must point at a version of THIS
--       point — a lone FK to market_point_versions.id could still link a
--       sibling's history. Composite FK via UNIQUE(id, point_id).
--   (b) market_point_versions.previous_version_id must chain within the
--       same point — same composite trick, self-referential.
--   (c) observation_id → NOT NULL: no untraceable normalized price.
--   (d) OHLC envelope + nonneg volume enforced by CHECK — direct SQL
--       cannot bypass lib/market.ts validation.
--
-- Circular creation is safe: a point inserts with current_version_id NULL,
-- its v1 version then fills the pointer via UPDATE.
--
-- Production preflight (run before apply):
--   SELECT count(*) FROM market_point_versions WHERE observation_id IS NULL
--   → 0   (table is empty pre-pilot — ALPHAVANTAGE_API_KEY absent)

ALTER TABLE market_point_versions
  ADD CONSTRAINT market_point_versions_id_point_uq UNIQUE (id, point_id);

ALTER TABLE market_points
  ADD CONSTRAINT market_points_current_same_point
    FOREIGN KEY (current_version_id, id)
    REFERENCES market_point_versions (id, point_id);

ALTER TABLE market_point_versions
  ADD CONSTRAINT market_point_versions_prev_same_point
    FOREIGN KEY (previous_version_id, point_id)
    REFERENCES market_point_versions (id, point_id);

ALTER TABLE market_point_versions
  ALTER COLUMN observation_id SET NOT NULL;

ALTER TABLE market_point_versions
  ADD CONSTRAINT market_point_versions_ohlc_valid CHECK (
    open > 0 AND high > 0 AND low > 0 AND close > 0
    AND low <= high
    AND open BETWEEN low AND high
    AND close BETWEEN low AND high
  ),
  ADD CONSTRAINT market_point_versions_volume_nonneg
    CHECK (volume IS NULL OR volume >= 0);

COMMIT;
