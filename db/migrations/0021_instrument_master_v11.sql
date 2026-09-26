BEGIN;

-- 0021: Instrument Master V1.1 — correctness/provenance hardening.
--
--   (a) CFI is a CLASSIFICATION (ISO 10962), not a globally-unique
--       identifier — moved to instrument_versions.cfi and out of the
--       unique identifier schemes.
--   (b) is_primary_listing becomes nullable: NULL = unknown (providers
--       gave us no primary-listing signal), true/false only when a
--       provider actually asserts it. Never inferred.
--   (c) master_derivations: typed provenance bridge so every promoted
--       master row traces to the observations that justify it.
--       One promoted fact ≈ several observations (SEC discovers,
--       OpenFIGI asserts, ISO references the venue).

-- (a) CFI → versioned classification column
ALTER TABLE instrument_versions ADD COLUMN cfi text;

ALTER TABLE instrument_identifiers
  DROP CONSTRAINT IF EXISTS instrument_identifiers_scheme_check;
ALTER TABLE instrument_identifiers
  ADD CONSTRAINT instrument_identifiers_scheme_check
  CHECK (scheme IN ('isin','share_class_figi','composite_figi','other'));

DROP INDEX uq_instrument_identifiers_global;
CREATE UNIQUE INDEX uq_instrument_identifiers_global
  ON instrument_identifiers (scheme, value)
  WHERE scheme IN ('isin','share_class_figi','composite_figi');

-- (b) primary-listing certainty removed: NULL = not established
ALTER TABLE listing_versions ALTER COLUMN is_primary_listing DROP NOT NULL;
ALTER TABLE listing_versions ALTER COLUMN is_primary_listing DROP DEFAULT;

-- (c) typed derivation bridge. Exactly one subject FK per row —
-- auditable joins, no JSON ids.
CREATE TABLE master_derivations (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  subject_type             text NOT NULL CHECK (subject_type IN (
    'instrument','instrument_version','listing','listing_version',
    'venue','venue_version','instrument_identifier','listing_identifier'
  )),
  instrument_id            uuid REFERENCES financial_instruments(id),
  instrument_version_id    uuid REFERENCES instrument_versions(id),
  listing_id               uuid REFERENCES instrument_listings(id),
  listing_version_id       uuid REFERENCES listing_versions(id),
  venue_id                 uuid REFERENCES trading_venues(id),
  venue_version_id         uuid REFERENCES trading_venue_versions(id),
  instrument_identifier_id uuid REFERENCES instrument_identifiers(id),
  listing_identifier_id    uuid REFERENCES listing_identifiers(id),
  observation_id           uuid NOT NULL REFERENCES reference_observations(id),
  role                     text NOT NULL CHECK (role IN (
    'asserts','discovers','corroborates','venue_reference'
  )),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((
    (instrument_id IS NOT NULL)::int +
    (instrument_version_id IS NOT NULL)::int +
    (listing_id IS NOT NULL)::int +
    (listing_version_id IS NOT NULL)::int +
    (venue_id IS NOT NULL)::int +
    (venue_version_id IS NOT NULL)::int +
    (instrument_identifier_id IS NOT NULL)::int +
    (listing_identifier_id IS NOT NULL)::int
  ) = 1)
);
CREATE INDEX idx_master_derivations_obs ON master_derivations (observation_id);
CREATE INDEX idx_master_derivations_instrument
  ON master_derivations (instrument_id) WHERE instrument_id IS NOT NULL;
CREATE INDEX idx_master_derivations_instrument_version
  ON master_derivations (instrument_version_id)
  WHERE instrument_version_id IS NOT NULL;
CREATE INDEX idx_master_derivations_listing
  ON master_derivations (listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX idx_master_derivations_listing_version
  ON master_derivations (listing_version_id)
  WHERE listing_version_id IS NOT NULL;
CREATE INDEX idx_master_derivations_venue
  ON master_derivations (venue_id) WHERE venue_id IS NOT NULL;
CREATE INDEX idx_master_derivations_venue_version
  ON master_derivations (venue_version_id) WHERE venue_version_id IS NOT NULL;
CREATE INDEX idx_master_derivations_instrument_identifier
  ON master_derivations (instrument_identifier_id)
  WHERE instrument_identifier_id IS NOT NULL;
CREATE INDEX idx_master_derivations_listing_identifier
  ON master_derivations (listing_identifier_id)
  WHERE listing_identifier_id IS NOT NULL;

-- == PG-ONLY: security posture + invariants ===============================

-- dedupe derivations at DB level (NULLS NOT DISTINCT → the seven other
-- subject columns compare equal when all NULL)
CREATE UNIQUE INDEX uq_master_derivations
  ON master_derivations (
    observation_id, role,
    instrument_id, instrument_version_id, listing_id, listing_version_id,
    venue_id, venue_version_id, instrument_identifier_id,
    listing_identifier_id
  ) NULLS NOT DISTINCT;

ALTER TABLE master_derivations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE master_derivations FROM anon, authenticated;

CREATE TRIGGER trg_master_derivations_immutable
  BEFORE UPDATE OR DELETE ON master_derivations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
