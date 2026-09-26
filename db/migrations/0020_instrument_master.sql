BEGIN;

-- 0020: Financial Instrument Master V1.
--
-- Hierarchy (three separate objects, never collapsed):
--
--   entities (issuer / legal entity — e.g. company:alphabet, CIK 1652044)
--     └─ financial_instruments          (Alphabet Class A ≠ Class C)
--          └─ instrument_listings       (× trading venue)
--               └─ listing_versions     (ticker, currency, status)
--
-- Identifier scopes (ISO 6166 / OpenFIGI / ISO 10383 / SEC EDGAR):
--   cik            → entity identifier (filer) — lives in entity_identifiers
--   isin           → instrument identifier, globally unique (ISO 6166)
--   share_class_figi → instrument identifier (share-class grouping)
--   composite_figi → instrument identifier (country/market composite)
--   cfi            → instrument classification (ISO 10962), globally unique
--   figi           → listing/venue-level tradable identifier
--   ticker         → listing_version state — NOT globally unique, NOT identity
--   mic            → venue identity — trading_venues.mic (ISO 10383)
--
-- Every provider-derived row traces to an append-only
-- reference_observations record (provider + dataset + raw payload + hash).

-- ── Phase 2: registry observation layer ─────────────────────────────────

CREATE TABLE reference_observations (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  provider     text NOT NULL CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified', 'other'
  )),
  dataset      text NOT NULL,            -- 'company_tickers_exchange' | 'mic_list' | 'mapping_v3' | …
  record_key   text NOT NULL,            -- provider record key (cik, MIC, job digest …)
  source_url   text,
  payload      jsonb NOT NULL,           -- raw provider record, verbatim
  content_hash text NOT NULL,            -- sha256 of canonicalized payload — dedupe key
  observed_at  timestamptz,              -- provider-side timestamp when published
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
-- same record re-fetched unchanged dedupes; a changed payload appends a new row
CREATE UNIQUE INDEX uq_reference_observations
  ON reference_observations (provider, dataset, record_key, content_hash);
CREATE INDEX idx_reference_observations_record
  ON reference_observations (provider, dataset, record_key);

-- ── Phase 3: trading venue master ────────────────────────────────────────

CREATE TABLE trading_venues (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  mic                text NOT NULL UNIQUE,   -- ISO 10383 MIC is the canonical identity
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','expired','updated')),
  current_version_id uuid,                   -- mutable pointer, like events.current_version_id
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trading_venue_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  venue_id            uuid NOT NULL REFERENCES trading_venues(id),
  version_no          integer NOT NULL,
  market_name         text NOT NULL,         -- ISO MARKET NAME-INSTITUTION DESCRIPTION
  legal_entity_name   text,
  lei                 text,                  -- venue operator LEI from ISO 10383 row
  country_code        text,                  -- ISO 3166-1 alpha-2
  city                text,
  operating_mic       text,                  -- parent operating MIC
  mic_role            text CHECK (mic_role IN ('operating','segment')),
  market_category     text,                  -- ISO MARKET CATEGORY CODE (RMKT, MLTF, ATSS…)
  acronym             text,
  status              text NOT NULL DEFAULT 'active',
  valid_from          timestamptz,
  valid_to            timestamptz,
  observation_id      uuid REFERENCES reference_observations(id),
  previous_version_id uuid REFERENCES trading_venue_versions(id),
  observed_at         timestamptz NOT NULL DEFAULT now(),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (venue_id, version_no)
);

-- ── Phase 4/5: financial instrument identity + versions ─────────────────

CREATE TABLE financial_instruments (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key      text NOT NULL UNIQUE,   -- 'instrument:alphabet:class_a_common_stock'
  issuer_entity_id   uuid REFERENCES entities(id),  -- nullable: indices, some derivatives
  instrument_type    text NOT NULL CHECK (instrument_type IN (
    'common_stock','preferred_stock','depositary_receipt',
    'bond','note','etf','fund','index','future','option','other'
  )),
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','inactive','suspended','withdrawn')),
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_financial_instruments_issuer
  ON financial_instruments (issuer_entity_id);

CREATE TABLE instrument_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  instrument_id       uuid NOT NULL REFERENCES financial_instruments(id),
  version_no          integer NOT NULL,
  name                text NOT NULL,
  short_name          text,
  asset_class         text NOT NULL DEFAULT 'equity' CHECK (asset_class IN (
    'equity','fixed_income','fund','index','commodity','derivative','other'
  )),
  instrument_type     text NOT NULL,         -- snapshot of type at observation time
  currency            text,                  -- ISO 4217
  issue_date          date,
  maturity_date       date,
  share_class         text,                  -- 'A','B','C',…
  voting_class        text,                  -- 'voting','non_voting','limited_voting'
  status              text NOT NULL DEFAULT 'active',
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  observation_id      uuid REFERENCES reference_observations(id),
  previous_version_id uuid REFERENCES instrument_versions(id),
  observed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, version_no)
);

-- ── Phase 6/10: instrument-scoped identifiers ────────────────────────────
-- Scope is explicit in the table: instrument-level schemes only.
-- CIK NEVER lives here — it is an entity/filer identifier (entity_identifiers).
-- ticker NEVER lives here — it is listing state (listing_versions).
-- Globally-unique schemes get a partial unique index; provider-namespaced
-- schemes ('other', …) carry namespace in metadata and are only indexed.

CREATE TABLE instrument_identifiers (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  instrument_id            uuid NOT NULL REFERENCES financial_instruments(id),
  scheme                   text NOT NULL CHECK (scheme IN (
    'isin','share_class_figi','composite_figi','cfi','other'
  )),
  value                    text NOT NULL,
  scope                    text NOT NULL DEFAULT 'global' CHECK (scope IN (
    'global','composite','instrument','provider'
  )),
  provider                 text NOT NULL,    -- who asserted it
  observation_id           uuid REFERENCES reference_observations(id),
  valid_from               timestamptz,
  valid_to                 timestamptz,
  supersedes_identifier_id uuid REFERENCES instrument_identifiers(id),
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_instrument_identifiers_global
  ON instrument_identifiers (scheme, value)
  WHERE scheme IN ('isin','share_class_figi','composite_figi','cfi');
CREATE INDEX idx_instrument_identifiers_lookup
  ON instrument_identifiers (scheme, value);

-- ── Phase 7/8: listing master + versions ─────────────────────────────────
-- A listing is one trading line: instrument × venue. Ticker is mutable
-- market state, versioned below — never identity.
-- No UNIQUE(instrument_id, venue_id): multiple trading lines per venue
-- are possible; uniqueness is on the internal canonical_key.

CREATE TABLE instrument_listings (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key      text NOT NULL UNIQUE,   -- 'listing:alphabet:class_a_common_stock:xnas'
  instrument_id      uuid NOT NULL REFERENCES financial_instruments(id),
  venue_id           uuid NOT NULL REFERENCES trading_venues(id),
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','delisted','inactive')),
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_instrument_listings_instrument
  ON instrument_listings (instrument_id);
CREATE INDEX idx_instrument_listings_venue
  ON instrument_listings (venue_id);

CREATE TABLE listing_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  listing_id          uuid NOT NULL REFERENCES instrument_listings(id),
  version_no          integer NOT NULL,
  ticker              text,                  -- market symbol at this point in time
  currency            text,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','delisted','inactive')),
  is_primary_listing  boolean NOT NULL DEFAULT false,
  valid_from          timestamptz,
  valid_to            timestamptz,
  observation_id      uuid REFERENCES reference_observations(id),
  previous_version_id uuid REFERENCES listing_versions(id),
  observed_at         timestamptz NOT NULL DEFAULT now(),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (listing_id, version_no)
);
-- market-context lookup: ticker + venue, NOT global ticker uniqueness
CREATE INDEX idx_listing_versions_ticker ON listing_versions (ticker);

-- ── Phase 9: listing-scoped identifiers ──────────────────────────────────
-- Venue-level FIGI identifies one tradable line; local codes are
-- provider-namespaced and only indexed.

CREATE TABLE listing_identifiers (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  listing_id               uuid NOT NULL REFERENCES instrument_listings(id),
  scheme                   text NOT NULL CHECK (scheme IN (
    'figi','local_security_code','other'
  )),
  value                    text NOT NULL,
  provider                 text NOT NULL,
  observation_id           uuid REFERENCES reference_observations(id),
  valid_from               timestamptz,
  valid_to                 timestamptz,
  supersedes_identifier_id uuid REFERENCES listing_identifiers(id),
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_listing_identifiers_figi
  ON listing_identifiers (scheme, value) WHERE scheme = 'figi';
CREATE INDEX idx_listing_identifiers_lookup
  ON listing_identifiers (scheme, value);

-- current_version_id back-references (deferred: created after version tables)
ALTER TABLE trading_venues
  ADD CONSTRAINT fk_venues_current_version
  FOREIGN KEY (current_version_id) REFERENCES trading_venue_versions(id);
ALTER TABLE financial_instruments
  ADD CONSTRAINT fk_instruments_current_version
  FOREIGN KEY (current_version_id) REFERENCES instrument_versions(id);
ALTER TABLE instrument_listings
  ADD CONSTRAINT fk_listings_current_version
  FOREIGN KEY (current_version_id) REFERENCES listing_versions(id);

-- == PG-ONLY: security posture + append-only invariants ====================
-- Explicit even though 0018 default privileges + event trigger already
-- cover new tables: RLS deny-by-default, zero API-role grants.

ALTER TABLE reference_observations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_venues           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_venue_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_instruments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_identifiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_listings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_identifiers      ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  reference_observations, trading_venues, trading_venue_versions,
  financial_instruments, instrument_versions, instrument_identifiers,
  instrument_listings, listing_versions, listing_identifiers
FROM anon, authenticated;

-- append-only: observations and all version/assertion history.
-- corrections append new records (or superseding assertions); history
-- is never rewritten.
CREATE TRIGGER trg_reference_observations_immutable
  BEFORE UPDATE OR DELETE ON reference_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_venue_versions_immutable
  BEFORE UPDATE OR DELETE ON trading_venue_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_instrument_versions_immutable
  BEFORE UPDATE OR DELETE ON instrument_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_listing_versions_immutable
  BEFORE UPDATE OR DELETE ON listing_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_instrument_identifiers_immutable
  BEFORE UPDATE OR DELETE ON instrument_identifiers
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER trg_listing_identifiers_immutable
  BEFORE UPDATE OR DELETE ON listing_identifiers
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
