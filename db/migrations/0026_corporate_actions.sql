BEGIN;

-- 0026: Corporate Actions V1 — canonical actions, append-only versions,
-- immutable provider assertions, typed derivations.
--
-- Identity law: corporate actions attach to financial_instruments.id —
-- never to a ticker string and never to a market series. Listings are
-- recorded only as source_listing_id (transport/provenance).
--
--   reference_observations (raw provider payload)
--        ↓ corporate_action_assertions (immutable provider truth)
--        ↓ reconcile instrument+type+ex_date
--   corporate_actions → corporate_action_versions (canonical semantic
--        state; corrections append, never UPDATE)
--        ↓ corporate_action_derivations (asserts/corroborates/conflicts)
--
-- Also widens market_series.price_basis: 'provider_adjusted' joins
-- 'as_traded' — provider-supplied adjusted bars are their own series,
-- never a recomputation (no homemade divCash/splitFactor formulas).

CREATE TABLE corporate_actions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key       text NOT NULL UNIQUE,
  instrument_id       uuid NOT NULL REFERENCES financial_instruments(id),
  action_type         text NOT NULL
                      CHECK (action_type IN ('cash_dividend','stock_split')),
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','cancelled')),
  current_version_id  uuid,           -- mutable pointer, like listings
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corporate_action_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  action_id           uuid NOT NULL REFERENCES corporate_actions(id),
  version_no          integer NOT NULL,
  ex_date             date,
  declaration_date    date,
  record_date         date,
  payment_date        date,
  cash_amount         numeric,
  currency            text,
  split_from          numeric,
  split_to            numeric,
  split_factor        numeric,
  status              text NOT NULL
                      CHECK (status IN ('active','cancelled')),
  observation_id      uuid NOT NULL REFERENCES reference_observations(id),
  previous_version_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, version_no),
  -- composite target for both pointer FKs (0024 pattern): a pointer can
  -- never reference a version belonging to a different action
  UNIQUE (id, action_id),
  -- a version is dividend-shaped or split-shaped, never both
  CHECK (NOT (
    cash_amount IS NOT NULL
    AND (split_from IS NOT NULL OR split_to IS NOT NULL
         OR split_factor IS NOT NULL)
  ))
);

ALTER TABLE corporate_actions
  ADD CONSTRAINT corporate_actions_current_version_fkey
  FOREIGN KEY (current_version_id, id)
  REFERENCES corporate_action_versions (id, action_id);
ALTER TABLE corporate_action_versions
  ADD CONSTRAINT corporate_action_versions_previous_fkey
  FOREIGN KEY (previous_version_id, action_id)
  REFERENCES corporate_action_versions (id, action_id);

CREATE INDEX idx_corpact_versions_action
  ON corporate_action_versions (action_id);
CREATE INDEX idx_corpact_actions_instrument
  ON corporate_actions (instrument_id);
CREATE INDEX idx_corpact_actions_ex_lookup
  ON corporate_actions (instrument_id, action_type, canonical_key);

CREATE TABLE corporate_action_assertions (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  instrument_id        uuid NOT NULL REFERENCES financial_instruments(id),
  source_listing_id    uuid REFERENCES instrument_listings(id),
  provider             text NOT NULL CHECK (provider IN (
    'sec_edgar','iso_10383','openfigi','anna','manual_verified',
    'alphavantage','tiingo','other'
  )),
  dataset              text NOT NULL,
  -- provider-scoped record key, e.g. 'aapl:ex:2020-08-31' — dedupe key,
  -- NOT canonical identity
  provider_record_key  text NOT NULL,
  action_type          text NOT NULL
                       CHECK (action_type IN ('cash_dividend','stock_split')),
  ex_date              date NOT NULL,
  declaration_date     date,
  record_date          date,
  payment_date         date,
  cash_amount          numeric,
  currency             text,
  split_from           numeric,
  split_to             numeric,
  split_factor         numeric,
  -- provider's own status string ('completed','cancelled', …) preserved
  -- verbatim; canonical status mapping happens at reconcile time
  provider_status      text,
  action_id            uuid REFERENCES corporate_actions(id),
  observation_id       uuid NOT NULL REFERENCES reference_observations(id),
  observed_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (
    cash_amount IS NOT NULL
    AND (split_from IS NOT NULL OR split_to IS NOT NULL
         OR split_factor IS NOT NULL)
  )),
  UNIQUE (provider, dataset, provider_record_key, observation_id)
);
CREATE INDEX idx_corpact_assertions_instrument
  ON corporate_action_assertions (instrument_id, action_type, ex_date);
CREATE INDEX idx_corpact_assertions_action
  ON corporate_action_assertions (action_id);
CREATE INDEX idx_corpact_assertions_obs
  ON corporate_action_assertions (observation_id);

CREATE TABLE corporate_action_derivations (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  action_id          uuid NOT NULL REFERENCES corporate_actions(id),
  action_version_id  uuid NOT NULL REFERENCES corporate_action_versions(id),
  assertion_id       uuid NOT NULL
                     REFERENCES corporate_action_assertions(id),
  observation_id     uuid NOT NULL REFERENCES reference_observations(id),
  -- 'asserts' = supplied canonical fields for this version
  -- 'corroborates' = agrees with the canonical state it names
  -- 'conflicts' = provider disagreement — recorded, never averaged
  role               text NOT NULL
                     CHECK (role IN ('asserts','corroborates','conflicts')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_version_id, assertion_id, role)
);
CREATE INDEX idx_corpact_derivations_action
  ON corporate_action_derivations (action_id);
CREATE INDEX idx_corpact_derivations_version
  ON corporate_action_derivations (action_version_id);
CREATE INDEX idx_corpact_derivations_assertion
  ON corporate_action_derivations (assertion_id);

-- == PG-ONLY: security + append-only invariants ==========================

-- 'provider_adjusted' joins the price_basis allowlist: provider-supplied
-- adjusted bars get their own series — never a recomputation (no homemade
-- divCash/splitFactor formulas). The CHECK was inline in 0023; prod's
-- auto-name is market_series_price_basis_check, pg-mem's differs, so this
-- is PG-only and the test harness patches the literal instead.
ALTER TABLE market_series DROP CONSTRAINT market_series_price_basis_check;
ALTER TABLE market_series
  ADD CONSTRAINT market_series_price_basis_check
  CHECK (price_basis IN ('as_traded','provider_adjusted'));

ALTER TABLE corporate_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_action_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_action_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_action_derivations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE corporate_actions FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE corporate_action_versions FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE corporate_action_assertions FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE corporate_action_derivations FROM anon, authenticated;

CREATE TRIGGER trg_corpact_versions_immutable
  BEFORE UPDATE OR DELETE ON corporate_action_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_corpact_assertions_immutable
  BEFORE UPDATE OR DELETE ON corporate_action_assertions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_corpact_derivations_immutable
  BEFORE UPDATE OR DELETE ON corporate_action_derivations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
