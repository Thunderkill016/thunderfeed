-- 0031_vndirect_provider.sql — VNDirect dchart joins the provider
-- allowlist for VN market data (HOSE listings + VN-Index). No API key;
-- raw payloads land in reference_observations before bars are promoted,
-- same as every other provider.

BEGIN;

-- == PG-ONLY: provider allowlist (prod constraint auto-named in 0020;
-- pg-mem names it differently — same treatment as 0025/0027/0029/0030) ==
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'worldbank', 'imf', 'vndirect',
    'other'
  ));

COMMIT;
