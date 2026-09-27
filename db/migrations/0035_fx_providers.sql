-- 0035_fx_providers.sql — phase-2 FX sources, no API keys required.
--
--   reference_observations.provider gains:
--     'vietcombank' — the bank's public pXML rate board (official bid/ask
--        quotes; the board itself asks for ≤1 request/5min).
--     'fawaz' — the community currency-api on jsDelivr, whose dated tags
--        carry real USD/VND history (the leg the derived series need to
--        backfill).
--
-- Binance P2P observations reuse provider 'binance' — same organisation,
-- different dataset ('p2p'). 'derived' keeps carrying computed series.
--
-- PG-ONLY widening like every constraint edit before it; pg-mem relaxes
-- the same list textually in tests.

BEGIN;

-- == PG-ONLY: FX provider allowlist ==
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'worldbank', 'imf', 'vndirect',
    'giavang', 'binance', 'er_api', 'vietcombank', 'fawaz', 'derived',
    'other'
  ));

COMMIT;
