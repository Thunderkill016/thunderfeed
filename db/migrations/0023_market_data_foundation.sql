BEGIN;

-- 0023: Market Data Foundation V1.
--
--   listing identity ──► market_series ──► market_points (session_date)
--        │                                     │
--        │                        market_point_versions (append-only OHLCV)
--        ▼                                     │
--   reference_observations ◄── observation_id ─┘
--
--   Market facts FK into instrument_listings.id — a listing survives
--   ticker renames, so price history never breaks. Ticker is only a
--   provider-request transport parameter, never identity.
--
--   V1 allows exactly one series shape: interval='1d',
--   session_type='regular', price_basis='as_traded'. Adjusted/total-return
--   semantics are deliberately NOT encodable until a provider supplies
--   them with documented semantics.

CREATE TABLE market_series (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key text NOT NULL UNIQUE,  -- 'series:<listing_key>:alphavantage:time_series_daily:1d:regular:as_traded'
  listing_id    uuid NOT NULL REFERENCES instrument_listings(id),
  provider      text NOT NULL,
  dataset       text NOT NULL,
  "interval"    text NOT NULL CHECK ("interval" IN ('1d')),
  session_type  text NOT NULL CHECK (session_type IN ('regular')),
  price_basis   text NOT NULL CHECK (price_basis IN ('as_traded')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- one series per (listing, provider, dataset, granularity, session, basis)
  UNIQUE (listing_id, provider, dataset, "interval", session_type, price_basis)
);
CREATE INDEX idx_market_series_listing ON market_series (listing_id);

-- One stable observation period per series. session_date is DATE — the
-- market's trading day, not a UTC-midnight timestamp pretending to be one.
CREATE TABLE market_points (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  series_id          uuid NOT NULL REFERENCES market_series(id),
  session_date       date NOT NULL,
  current_version_id uuid,             -- mutable pointer, like financial_instruments
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, session_date)
);
CREATE INDEX idx_market_points_series_date
  ON market_points (series_id, session_date DESC);

-- Append-only OHLCV assertions. Provider revisions append version_no+1 and
-- move market_points.current_version_id; history is never rewritten.
-- open/high/low/close are numeric (not float) — exact decimal storage.
-- volume is bigint and NULLABLE: an absent provider value stays unknown,
-- never coerced to 0. currency is NULL unless the provider asserts it.
CREATE TABLE market_point_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  point_id            uuid NOT NULL REFERENCES market_points(id),
  version_no          integer NOT NULL,
  open                numeric NOT NULL,
  high                numeric NOT NULL,
  low                 numeric NOT NULL,
  close               numeric NOT NULL,
  volume              bigint,
  currency            text,
  observation_id      uuid REFERENCES reference_observations(id),
  previous_version_id uuid REFERENCES market_point_versions(id),
  observed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (point_id, version_no)
);
CREATE INDEX idx_market_point_versions_point
  ON market_point_versions (point_id);
CREATE INDEX idx_market_point_versions_obs
  ON market_point_versions (observation_id);

-- == PG-ONLY: security posture + append-only invariants ====================

-- 'alphavantage' joins the provider allowlist. The original CHECK was
-- inline/unnamed in 0020; prod auto-named it reference_observations_provider_check
-- (verified against pg_constraint). pg-mem names it differently, so this
-- section is PG-only and the test harness patches the literal instead.
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'other'
  ));

ALTER TABLE market_series          ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_points          ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_point_versions  ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  market_series, market_points, market_point_versions
  FROM anon, authenticated;

CREATE TRIGGER trg_market_point_versions_immutable
  BEFORE UPDATE OR DELETE ON market_point_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
