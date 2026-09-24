-- ============================================================================
-- Thunderfeed core schema — P0 (10 tables)
-- Append-only temporal intelligence: Evidence → Event → Claim → Change.
--
-- Invariants encoded here:
--   * History is never overwritten — every mutation produces a new version row.
--   * Logical identity is stable: UUIDv7 ids, independent of headline/title.
--   * Four timestamps stay distinct:
--       published_at   — when the SOURCE published
--       observed_at    — when Thunderfeed saw the content
--       valid_from     — when a claim's value became true in the world
--       detected_at    — when Thunderfeed detected a change
--   * current_version_id pointers are convenience indexes, not the truth —
--     truth is the version chain itself.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- UUIDv7 generator (time-ordered ids; PostgreSQL 18 has uuidv7() natively —
-- keep this shim so the schema works on older versions).
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE
  ts_ms BIGINT := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes BYTEA := substring(int8send(ts_ms << 16) FROM 1 FOR 6)
                 || gen_random_bytes(10);
BEGIN
  -- version 7 (0111) in high nibble of byte 6, variant 10 in byte 8
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ---------------------------- controlled vocab -----------------------------

CREATE TYPE source_kind AS ENUM ('primary', 'publisher', 'community', 'aggregator');
CREATE TYPE source_region AS ENUM ('vietnam', 'global', 'unknown');
CREATE TYPE document_type AS ENUM (
  'article', 'press_release', 'transcript', 'report',
  'blog', 'social_post', 'dataset', 'other'
);
CREATE TYPE ingest_channel AS ENUM ('rss', 'gdelt', 'hn', 'api', 'crawler', 'manual');
CREATE TYPE event_type AS ENUM (
  'announcement', 'policy', 'release', 'market_move', 'incident',
  'conflict', 'earnings', 'research', 'product_launch', 'ongoing_story', 'other'
);
CREATE TYPE event_status AS ENUM ('emerging', 'active', 'stable', 'resolved', 'merged', 'archived');
CREATE TYPE event_version_status AS ENUM ('emerging', 'active', 'stable', 'resolved');
CREATE TYPE evidence_relationship AS ENUM (
  'origin', 'primary_evidence', 'coverage', 'analysis', 'discovery'
);
CREATE TYPE attach_method AS ENUM ('semantic', 'rule', 'llm', 'manual');
CREATE TYPE claim_type AS ENUM (
  'fact', 'numeric', 'quote', 'status', 'causal', 'forecast', 'interpretation'
);
CREATE TYPE claim_value_type AS ENUM (
  'text', 'number', 'range', 'boolean', 'entity', 'date', 'json'
);
CREATE TYPE claim_state AS ENUM (
  'reported', 'supported', 'confirmed', 'disputed',
  'corrected', 'retracted', 'unresolved'
);
CREATE TYPE claim_change_type AS ENUM (
  'initial', 'value_changed', 'scope_changed', 'confirmed',
  'disputed', 'corrected', 'retracted'
);
CREATE TYPE evidence_stance AS ENUM (
  'originates', 'supports', 'contradicts', 'mentions', 'corrects'
);
CREATE TYPE evidence_strength AS ENUM ('direct', 'indirect', 'secondary');
CREATE TYPE extraction_method AS ENUM ('rule', 'model', 'manual');
CREATE TYPE event_change_reason AS ENUM (
  'event_created', 'new_material_claim', 'claim_updated', 'claim_corrected',
  'claim_disputed', 'primary_confirmation', 'event_resolved', 'manual'
);
CREATE TYPE change_type AS ENUM (
  'event_created', 'new_claim', 'claim_updated', 'claim_confirmed',
  'claim_disputed', 'claim_corrected', 'claim_retracted',
  'new_primary_source', 'new_coverage', 'event_resolved'
);
CREATE TYPE materiality AS ENUM ('low', 'medium', 'high');

-- --------------------------------- sources ---------------------------------

-- A publisher/origin of information. discovery channels (GDELT) live on the
-- document, not here — GDELT is a provider, not an author.
CREATE TABLE sources (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  name        text NOT NULL UNIQUE,   -- feed-supplied name is the natural key
  domain      text,
  kind        source_kind NOT NULL DEFAULT 'publisher',
  region      source_region NOT NULL DEFAULT 'unknown',
  country     text,
  language    text,
  reliability_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sources_domain ON sources (domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_sources_kind ON sources (kind);

-- ---------------------------- evidence_documents ---------------------------

-- A logical document (one canonical URL). Its content mutates over time —
-- mutations land in evidence_versions, never here.
CREATE TABLE evidence_documents (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  source_id          uuid NOT NULL REFERENCES sources(id),
  canonical_url      text NOT NULL,
  external_id        text,                    -- HN item id, GDELT id, …
  document_type      document_type NOT NULL DEFAULT 'article',
  published_at       timestamptz,             -- source's own timestamp
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  current_version_id uuid,                    -- FK added below (cycle)
  discovered_via     ingest_channel NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, canonical_url)
);
CREATE INDEX idx_evidence_documents_url ON evidence_documents (canonical_url);
CREATE INDEX idx_evidence_documents_source ON evidence_documents (source_id);
CREATE INDEX idx_evidence_documents_last_seen ON evidence_documents (last_seen_at DESC);

-- ----------------------------- evidence_versions ---------------------------

-- One observed state of a document. Dedup rule for the writer:
-- on (document_id, content_hash) collision, bump documents.last_seen_at —
-- do NOT insert a duplicate version.
CREATE TABLE evidence_versions (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  document_id           uuid NOT NULL REFERENCES evidence_documents(id),
  version_no            int NOT NULL CHECK (version_no >= 1),
  title                 text NOT NULL,
  summary               text,
  content_text          text,
  structured_data       jsonb,
  content_hash          text NOT NULL,          -- sha256(title|summary|body)
  observed_at           timestamptz NOT NULL,   -- when WE saw it
  source_updated_at     timestamptz,            -- when the SOURCE says it changed
  supersedes_version_id uuid REFERENCES evidence_versions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no),
  UNIQUE (document_id, content_hash)
);
CREATE INDEX idx_evidence_versions_document
  ON evidence_versions (document_id, version_no DESC);
CREATE INDEX idx_evidence_versions_observed ON evidence_versions (observed_at DESC);

ALTER TABLE evidence_documents
  ADD CONSTRAINT fk_documents_current_version
  FOREIGN KEY (current_version_id) REFERENCES evidence_versions(id);

-- ---------------------------------- events ---------------------------------

-- Durable event identity. Headline/summary are NOT stored here — they are
-- state, and state lives in event_versions.
CREATE TABLE events (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_type            event_type NOT NULL DEFAULT 'other',
  topic                 text NOT NULL DEFAULT 'world',   -- app-level vocab
  status                event_status NOT NULL DEFAULT 'emerging',
  signature             text,                            -- resolver fingerprint:
                                                         -- entity keys + keyword
                                                         -- hash; candidates only
  first_seen_at         timestamptz NOT NULL,
  last_seen_at          timestamptz NOT NULL,
  occurred_at           timestamptz,                     -- when it happened IRL
  current_version_id    uuid,                            -- FK added below
  merged_into_event_id  uuid REFERENCES events(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_last_seen ON events (last_seen_at DESC);
CREATE INDEX idx_events_status ON events (status);
CREATE INDEX idx_events_signature ON events (signature) WHERE signature IS NOT NULL;

-- ------------------------------ event_versions -----------------------------

-- A material state of the event. Created ONLY on material change — never
-- for "+1 outlet rewrote the same facts".
CREATE TABLE event_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id            uuid NOT NULL REFERENCES events(id),
  version_no          int NOT NULL CHECK (version_no >= 1),
  title               text NOT NULL,
  summary             text NOT NULL,
  status              event_version_status NOT NULL,
  importance_score    double precision,
  started_at          timestamptz,
  effective_at        timestamptz NOT NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  previous_version_id uuid REFERENCES event_versions(id),
  change_reason       event_change_reason NOT NULL,
  content_hash        text NOT NULL,
  UNIQUE (event_id, version_no)
);
CREATE INDEX idx_event_versions_event
  ON event_versions (event_id, version_no DESC);

ALTER TABLE events
  ADD CONSTRAINT fk_events_current_version
  FOREIGN KEY (current_version_id) REFERENCES event_versions(id);

-- ------------------------------ event_evidence -----------------------------

-- Membership edge: which observed document-state belongs to which event.
-- Keep the graph — never collapse members into a lead article.
CREATE TABLE event_evidence (
  event_id            uuid NOT NULL REFERENCES events(id),
  evidence_version_id uuid NOT NULL REFERENCES evidence_versions(id),
  relationship        evidence_relationship NOT NULL DEFAULT 'coverage',
  cluster_score       double precision,
  attached_at         timestamptz NOT NULL DEFAULT now(),
  detached_at         timestamptz,
  attached_by         attach_method NOT NULL,
  PRIMARY KEY (event_id, evidence_version_id)
);
CREATE INDEX idx_event_evidence_event ON event_evidence (event_id);
CREATE INDEX idx_event_evidence_version ON event_evidence (evidence_version_id);

-- ---------------------------------- claims ---------------------------------

-- A logical proposition: the QUESTION, not the answer. claim_key is the
-- extractor's natural key — subject + predicate + scope fingerprint, e.g.
-- "fed|target_rate_upper_bound|meeting:2026-09". Value changes produce new
-- claim_versions, never a new claim.
CREATE TABLE claims (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id            uuid NOT NULL REFERENCES events(id),
  claim_key           text NOT NULL,
  subject_entity_id   uuid,                 -- FK to entities lands with P1
  predicate           text NOT NULL,
  scope_key           text,
  claim_type          claim_type NOT NULL DEFAULT 'fact',
  first_seen_at       timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  current_version_id  uuid,                 -- FK added below
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, claim_key)
);
CREATE INDEX idx_claims_event ON claims (event_id);

-- ------------------------------ claim_versions -----------------------------

-- The actual truth-state, versioned. "20 → 35 flights cancelled" is a diff
-- between two rows here — that diff IS the change engine.
CREATE TABLE claim_versions (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  claim_id              uuid NOT NULL REFERENCES claims(id),
  version_no            int NOT NULL CHECK (version_no >= 1),
  value_type            claim_value_type NOT NULL,
  value                 jsonb NOT NULL,
  unit                  text,
  qualifiers            jsonb,
  state                 claim_state NOT NULL DEFAULT 'reported',
  valid_from            timestamptz,          -- when the value became true IRL
  valid_to              timestamptz,
  observed_at           timestamptz NOT NULL, -- when WE saw this value
  confidence            double precision,
  previous_version_id   uuid REFERENCES claim_versions(id),
  change_type           claim_change_type NOT NULL DEFAULT 'initial',
  content_hash          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, version_no)
);
CREATE INDEX idx_claim_versions_claim
  ON claim_versions (claim_id, version_no DESC);

ALTER TABLE claims
  ADD CONSTRAINT fk_claims_current_version
  FOREIGN KEY (current_version_id) REFERENCES claim_versions(id);

-- ------------------------------ claim_evidence -----------------------------

-- Which observed document-state supports/contradicts which claim-state.
-- Stance + strength are how "10 syndications ≠ 10 independent evidence" is
-- enforced downstream.
CREATE TABLE claim_evidence (
  claim_version_id     uuid NOT NULL REFERENCES claim_versions(id),
  evidence_version_id  uuid NOT NULL REFERENCES evidence_versions(id),
  stance               evidence_stance NOT NULL DEFAULT 'supports',
  evidence_strength    evidence_strength NOT NULL DEFAULT 'secondary',
  excerpt              text,
  locator              jsonb,               -- {paragraph, page, timestamp, section}
  extracted_at         timestamptz NOT NULL DEFAULT now(),
  extraction_method    extraction_method NOT NULL,
  extraction_confidence double precision,
  PRIMARY KEY (claim_version_id, evidence_version_id)
);
CREATE INDEX idx_claim_evidence_claim_version
  ON claim_evidence (claim_version_id);
CREATE INDEX idx_claim_evidence_version
  ON claim_evidence (evidence_version_id);

-- ---------------------------------- changes --------------------------------

-- Material-change log — the "WHAT CHANGED" feed, derived but persisted for
-- cheap UI reads and alerts.
CREATE TABLE changes (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id              uuid NOT NULL REFERENCES events(id),
  claim_id              uuid REFERENCES claims(id),
  from_event_version_id uuid REFERENCES event_versions(id),
  to_event_version_id   uuid NOT NULL REFERENCES event_versions(id),
  from_claim_version_id uuid REFERENCES claim_versions(id),
  to_claim_version_id   uuid REFERENCES claim_versions(id),
  type                  change_type NOT NULL,
  materiality           materiality NOT NULL DEFAULT 'low',
  summary               text NOT NULL,
  detected_at           timestamptz NOT NULL   -- when WE detected it
);
CREATE INDEX idx_changes_event_time ON changes (event_id, detected_at DESC);
CREATE INDEX idx_changes_type ON changes (type);
CREATE INDEX idx_changes_detected ON changes (detected_at DESC);

-- == PG-ONLY: append-only triggers (plpgsql — skipped by pg-mem tests) ==
-- history tables reject UPDATE/DELETE outright; corrections are new versions.
-- event_evidence / claim_evidence stay mutable (detached_at / link updates).
CREATE OR REPLACE FUNCTION reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only — write a new version instead', TG_TABLE_NAME;
  RETURN NULL;
END;
$$;

CREATE TRIGGER evidence_versions_append_only
  BEFORE UPDATE OR DELETE ON evidence_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER event_versions_append_only
  BEFORE UPDATE OR DELETE ON event_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER claim_versions_append_only
  BEFORE UPDATE OR DELETE ON claim_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER changes_append_only
  BEFORE UPDATE OR DELETE ON changes
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
