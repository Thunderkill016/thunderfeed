BEGIN;

-- 0012: canonical entity identity — the durable layer the gazetteer
-- slugs resolve into. Gazetteer stays the text matcher; these tables
-- are the identity: aliases/identifiers/relationships point at entity
-- ids, never at matching strings.
CREATE TABLE entities (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key text NOT NULL UNIQUE,        -- 'company:nvidia', 'person:donald_trump'
  canonical_name text NOT NULL,
  entity_type   text NOT NULL CHECK (entity_type IN (
    'person', 'organization', 'company', 'government_body',
    'central_bank', 'multilateral_organization', 'country', 'region',
    'place', 'commodity', 'topic', 'event_series', 'brand', 'other'
  )),
  status        text NOT NULL DEFAULT 'active',
  country_code  text,                        -- ISO 3166-1 alpha-2 when meaningful
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_entities_type ON entities (entity_type);

-- many aliases → one canonical entity. An ambiguous alias does NOT
-- auto-resolve; disambiguation is an explicit future rule, so lookups
-- that can mean two things stay unresolved instead of guessing.
CREATE TABLE entity_aliases (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  entity_id        uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias            text NOT NULL,            -- surface form as written
  normalized_alias text NOT NULL,          -- lowercase, NFC
  language         text,
  alias_type       text NOT NULL DEFAULT 'common_name' CHECK (alias_type IN (
    'official_name', 'short_name', 'abbreviation', 'former_name',
    'brand_name', 'transliteration', 'common_name', 'ticker_like', 'other'
  )),
  valid_from       timestamptz,
  valid_to         timestamptz,
  evidence_version_id uuid REFERENCES evidence_versions(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, normalized_alias)
);
CREATE INDEX idx_entity_aliases_norm ON entity_aliases (normalized_alias);

-- identifiers are scheme-namespaced, never provider-shaped columns.
-- Globally-unique schemes (lei/cik/iso_country…) keep issuer NULL and
-- get the partial unique index; namespaced future schemes carry an
-- issuer and are only indexed, not globally unique.
CREATE TABLE entity_identifiers (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  scheme     text NOT NULL,                -- lei|cik|tax_id|business_registration|wikidata|iso_country|internal
  value      text NOT NULL,
  issuer     text,
  valid_from timestamptz,
  valid_to   timestamptz,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_entity_identifiers_global
  ON entity_identifiers (scheme, value) WHERE issuer IS NULL;
CREATE INDEX idx_entity_identifiers_entity ON entity_identifiers (entity_id);

-- relationships are versioned ASSERTIONS: a change appends a new row
-- whose supersedes_relationship_id points at the old one — history is
-- never overwritten. co-occurrence is NOT a relationship.
CREATE TABLE entity_relationships (
  id                        uuid PRIMARY KEY DEFAULT uuid_v7(),
  from_entity_id            uuid NOT NULL REFERENCES entities(id),
  to_entity_id              uuid NOT NULL REFERENCES entities(id),
  relationship_type         text NOT NULL CHECK (relationship_type IN (
    'parent_of', 'subsidiary_of', 'owns', 'owned_by', 'operates',
    'regulated_by', 'member_of', 'part_of', 'headquartered_in',
    'located_in', 'led_by', 'brand_of', 'successor_of',
    'predecessor_of', 'other'
  )),
  valid_from                timestamptz,
  valid_to                  timestamptz,
  evidence_version_id       uuid REFERENCES evidence_versions(id),
  source_method             text NOT NULL DEFAULT 'manual',
  confidence                real,
  supersedes_relationship_id uuid REFERENCES entity_relationships(id),
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_entity_rel_from ON entity_relationships (from_entity_id);
CREATE INDEX idx_entity_rel_to ON entity_relationships (to_entity_id);

-- event_entities gains the canonical id alongside the legacy slug.
-- The slug stays in V1 (backward compat); entity_id is the read key.
ALTER TABLE event_entities
  ADD COLUMN entity_id uuid REFERENCES entities(id);
CREATE INDEX idx_event_entities_entity ON event_entities (entity_id);

-- why an entity attaches: evidence-level mention provenance. Over
-- time event_entities becomes a projection of these rows.
CREATE TABLE evidence_entities (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  evidence_version_id uuid NOT NULL REFERENCES evidence_versions(id),
  entity_id           uuid NOT NULL REFERENCES entities(id),
  mention_role        text NOT NULL DEFAULT 'mentioned' CHECK (mention_role IN (
    'subject', 'actor', 'target', 'location', 'mentioned', 'issuer', 'other'
  )),
  in_title            boolean NOT NULL DEFAULT false,
  method              text NOT NULL DEFAULT 'gazetteer',
  confidence          real,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_version_id, entity_id, mention_role)
);
CREATE INDEX idx_evidence_entities_entity ON evidence_entities (entity_id);
CREATE INDEX idx_evidence_entities_version ON evidence_entities (evidence_version_id);

COMMIT;
