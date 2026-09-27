-- 0033_multi_asset_signals.sql — pivot to the multi-asset signal product.
--
--   1. signal_outcomes — every market_move delta is a falsifiable claim;
--      this table is where each claim gets checked. Pending rows are
--      minted inside applyDailyBars when the delta lands; a resolver job
--      fills them once the horizon session exists. Append-only after
--      resolution — the track record is the moat.
--   2. providers: giavang (VN gold boards + world spot), binance (crypto
--      klines), er_api (open.er-api reference FX rates).
--   3. instrument_type gains 'commodity' | 'crypto' | 'fx_pair';
--      asset_class gains 'crypto' | 'fx' ('commodity' already exists).
--   4. market_series.price_basis gains 'quoted' — non-exchange boards
--      (gold buy/sell quotes, FX reference rates) are quoted prices, not
--      traded prints. Quote-board convention, recorded in series metadata
--      {quote:'bid_ask'}: open=low=bid, high=close=ask so the day's pair is
--      preserved losslessly. 'as_traded' stays the only basis for real
--      OHLCV feeds.

BEGIN;

-- signal_outcomes — horizons count *trading sessions* of the same series
-- (T+1/5/20), not calendar days: weekends/holidays don't move a horizon.
CREATE TABLE signal_outcomes (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  delta_id            uuid NOT NULL REFERENCES data_deltas(id),
  horizon_sessions    integer NOT NULL CHECK (horizon_sessions IN (1,5,20)),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','expired')),
  outcome_point_id    uuid REFERENCES market_points(id),
  outcome_version_id  uuid REFERENCES market_point_versions(id),
  outcome_close       numeric,
  move_pct            numeric,   -- realized move vs the signal-session close
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delta_id, horizon_sessions)
);
CREATE INDEX idx_signal_outcomes_pending
  ON signal_outcomes (status) WHERE status = 'pending';

-- == PG-ONLY: provider allowlist (prod constraint auto-named in 0020;
-- pg-mem relaxes the same list textually in tests) ==
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'worldbank', 'imf', 'vndirect',
    'giavang', 'binance', 'er_api',
    'other'
  ));

-- == PG-ONLY: instrument_type taxonomy for non-equity assets ==
ALTER TABLE financial_instruments
  DROP CONSTRAINT financial_instruments_instrument_type_check;
ALTER TABLE financial_instruments
  ADD CONSTRAINT financial_instruments_instrument_type_check
  CHECK (instrument_type IN (
    'common_stock','preferred_stock','depositary_receipt',
    'bond','note','etf','fund','index','future','option',
    'commodity','crypto','fx_pair',
    'other'
  ));

-- == PG-ONLY: asset_class on instrument_versions ==
ALTER TABLE instrument_versions
  DROP CONSTRAINT instrument_versions_asset_class_check;
ALTER TABLE instrument_versions
  ADD CONSTRAINT instrument_versions_asset_class_check
  CHECK (asset_class IN (
    'equity','fixed_income','fund','index','commodity','derivative',
    'crypto','fx',
    'other'
  ));

-- == PG-ONLY: quoted price basis for non-trade boards ==
ALTER TABLE market_series
  DROP CONSTRAINT market_series_price_basis_check;
ALTER TABLE market_series
  ADD CONSTRAINT market_series_price_basis_check
  CHECK (price_basis IN ('as_traded','provider_adjusted','quoted'));

-- == PG-ONLY: security posture + outcome immutability =======================
-- The track record is only worth publishing if resolved rows cannot move:
-- pending → resolved/expired is the one lawful transition (the resolver),
-- deletes are never lawful, and a settled row is frozen.

ALTER TABLE signal_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE signal_outcomes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION reject_resolved_outcome_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signal_outcomes are append-only — no deletes';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'settled signal_outcomes are immutable — delta % outcome %',
      OLD.delta_id, OLD.horizon_sessions;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signal_outcomes_settled_immutable
  BEFORE UPDATE OR DELETE ON signal_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_resolved_outcome_mutation();

COMMIT;
