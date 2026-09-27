-- 0034_signal_kinds.sql — phase-2 signal vocabulary.
--
--   1. data_deltas.kind gains two asset-aware kinds:
--      'premium_shift' — the SJC-vs-world gold premium moved by a material
--        amount in absolute percentage points (a %-valued series, so the
--        relative market_move metric is the wrong lens).
--      'volume_spike' — a session's volume ran a material multiple of its
--        trailing baseline (crypto in phase 2; the detector is generic).
--   2. reference_observations.provider gains 'derived' — observations whose
--      payload is *computed from other rows* (the premium series inputs),
--      not fetched from an external source. Honest provenance: a derived
--      point is auditable to its legs instead of pretending to be a feed.
--
-- Both widenings are PG-ONLY like every constraint edit before them —
-- pg-mem relaxes the same lists textually in tests.

BEGIN;

-- == PG-ONLY: signal vocabulary ==
ALTER TABLE data_deltas
  DROP CONSTRAINT data_deltas_kind_check;
ALTER TABLE data_deltas
  ADD CONSTRAINT data_deltas_kind_check CHECK (kind IN (
    'macro_release', 'macro_revision', 'ca_declared', 'ca_updated',
    'market_move', 'premium_shift', 'volume_spike'
  ));

-- == PG-ONLY: computed observations ==
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'worldbank', 'imf', 'vndirect',
    'giavang', 'binance', 'er_api', 'derived',
    'other'
  ));

COMMIT;
