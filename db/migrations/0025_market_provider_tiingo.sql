BEGIN;

-- 0025: Tiingo joins the reference_observations provider allowlist.
-- No new market tables — Tiingo reuses the V1 market_series/points/
-- point_versions schema with provider='tiingo', dataset='eod_daily'.
-- The CHECK was (re)named reference_observations_provider_check in 0023;
-- verified against pg_constraint on prod.

-- == PG-ONLY: constraint rename dance — pg-mem auto-names the original ===

ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'other'
  ));

COMMIT;
