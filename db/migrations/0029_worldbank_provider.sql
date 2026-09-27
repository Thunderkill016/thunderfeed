-- 0029_worldbank_provider.sql — World Bank joins the provider allowlist.
-- Same tables as 0027; WB has no vintage dates so the apply layer uses
-- stableVintage mode (a rerun with identical values writes nothing —
-- only real revisions mint versions).

BEGIN;

-- == PG-ONLY: provider allowlist (prod constraint auto-named in 0020;
-- pg-mem names it differently — same treatment as 0025/0027) ==
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'worldbank', 'other'
  ));

COMMIT;
