-- 0032_market_move_deltas.sql — market prices join the delta feed.
--
-- `market_move` fires when a newly-landed session close differs from the
-- prior session's close by >= MATERIAL_MOVE_PCT (applied in
-- lib/db/market.ts — the feed only carries material moves, not every
-- daily close). Subject pointers follow the 0028 discipline: the delta
-- names the market_point it produced plus the version pair.

BEGIN;

ALTER TABLE data_deltas
  ADD COLUMN market_point_id        uuid REFERENCES market_points(id),
  ADD COLUMN market_version_id      uuid REFERENCES market_point_versions(id),
  ADD COLUMN prev_market_version_id uuid REFERENCES market_point_versions(id);

ALTER TABLE data_deltas
  ADD CONSTRAINT uq_data_deltas_market_version UNIQUE (market_version_id);

CREATE INDEX idx_data_deltas_market_point ON data_deltas (market_point_id);

-- == PG-ONLY: re-seat kind + subject CHECKs (0028 auto-names them) ======
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'data_deltas'::regclass AND contype = 'c'
  LOOP
    -- the 0028 subject XOR + kind allowlist are superseded below
    IF con.def LIKE '%point_id IS NULL%<>%action_id IS NULL%'
       OR con.def LIKE '%macro_release%' THEN
      EXECUTE format('ALTER TABLE data_deltas DROP CONSTRAINT %I',
                     con.conname);
    END IF;
  END LOOP;
END $$;

ALTER TABLE data_deltas
  ADD CONSTRAINT data_deltas_kind_check CHECK (kind IN (
    'macro_release', 'macro_revision', 'ca_declared', 'ca_updated',
    'market_move'
  ));

-- exactly one typed subject — the 0028 two-way XOR becomes a count
ALTER TABLE data_deltas ADD CONSTRAINT data_deltas_subject_check CHECK (
  (point_id IS NOT NULL)::int
  + (action_id IS NOT NULL)::int
  + (market_point_id IS NOT NULL)::int = 1
);

ALTER TABLE data_deltas ADD CONSTRAINT data_deltas_market_pairing CHECK (
  (market_point_id IS NULL) = (market_version_id IS NULL)
);

COMMIT;
