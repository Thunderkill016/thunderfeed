BEGIN;

-- 0014: identity hardening — closes the correctness gaps found after V1:
-- provenance on relationships/identifiers, canonical junction uniqueness,
-- append-only relationship enforcement, brand/company alias cleanup, and
-- the 'google' junction re-point now that the surface resolves to the
-- brand entity. Corrections append; nothing is silently overwritten.

-- ---- provenance columns ------------------------------------------------
-- structured-registry assertions (CIK universe, ISO codes) don't need an
-- EvidenceVersion — but every row must answer "why does ThunderFeed
-- believe this?".
ALTER TABLE entity_relationships
  ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE entity_identifiers
  ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- the 11 seeded relationships are curated assertions, NOT primary evidence
UPDATE entity_relationships SET provenance =
  '{"provider":"thunderfeed-curation","method":"curated_seed","note":"V1 seed: curated brand/company and central-bank HQ graph; not evidence-derived"}'::jsonb
WHERE provenance = '{}'::jsonb;

UPDATE entity_identifiers SET provenance =
  '{"provider":"SEC EDGAR","method":"registry_seed","note":"CIK from the EDGAR issuer universe used by the secEdgar adapter"}'::jsonb
WHERE scheme = 'cik' AND provenance = '{}'::jsonb;

UPDATE entity_identifiers SET provenance =
  '{"provider":"ISO 3166-1","method":"standard_registry","note":"alpha-2/alpha-3 country codes"}'::jsonb
WHERE scheme = 'iso_country' AND provenance = '{}'::jsonb;

-- ---- brand/company alias cleanup ----------------------------------------
-- V1 seeded brand surfaces onto the company entity AND the brand entity,
-- which made 'google', 'facebook', 'tiktok', 'chatgpt', 'claude',
-- 'starlink', 'deepmind', 'green sm' ambiguous (resolve → null). The
-- brand surface belongs only on the brand entity; company entities keep
-- legal/org surfaces.
DELETE FROM entity_aliases WHERE id IN (
  SELECT a.id FROM entity_aliases a
  JOIN entities e ON e.id = a.entity_id
  WHERE (e.canonical_key = 'company:alphabet'
         AND a.normalized_alias IN ('google', 'deepmind', 'google deepmind'))
     OR (e.canonical_key = 'company:meta_platforms'
         AND a.normalized_alias IN ('facebook'))
     OR (e.canonical_key = 'company:bytedance'
         AND a.normalized_alias IN ('tiktok', 'tik tok'))
     OR (e.canonical_key = 'company:openai'
         AND a.normalized_alias IN ('chatgpt', 'chat gpt'))
     OR (e.canonical_key = 'company:anthropic'
         AND a.normalized_alias IN ('claude', 'claude ai'))
     OR (e.canonical_key = 'company:spacex'
         AND a.normalized_alias IN ('starlink', 'falcon', 'falcon 9', 'falcon heavy'))
     OR (e.canonical_key = 'company:vinfast'
         AND a.normalized_alias IN ('green sm', 'green s.m', 'xanh sm'))
);

-- 'google' junction rows describe the brand surface — re-point them to
-- the brand entity (idempotent: rows already on the brand stay).
UPDATE event_entities SET entity_id =
  (SELECT id FROM entities WHERE canonical_key = 'brand:google')
WHERE entity_slug = 'google'
  AND entity_id <> (SELECT id FROM entities WHERE canonical_key = 'brand:google');

-- gazetteer-derived evidence links named the same surface — same re-point
UPDATE evidence_entities SET entity_id =
  (SELECT id FROM entities WHERE canonical_key = 'brand:google')
WHERE method = 'gazetteer' AND entity_id =
  (SELECT id FROM entities WHERE canonical_key = 'company:alphabet');

-- ---- alias normalization documentation ----------------------------------
-- the column comment said "lowercase, NFC"; runtime actually applies
-- normalizeText() — document the real rule at the schema level.
COMMENT ON COLUMN entity_aliases.normalized_alias IS
  'ThunderFeed normalizeText(): lowercase, diacritics stripped, punctuation stripped, whitespace collapsed. Distinct surfaces may share a normalized_alias; multi-entity normals stay unresolved (resolve → null).';

-- == PG-ONLY: canonical dedup + uniqueness + append-only ==================
-- invariant: one canonical entity per event. Production audit before
-- this migration: 0 duplicates. The collapse is defensive for legacy
-- databases that already carry a dup — keeper = in-title row, then
-- smallest slug (same rule the writer uses); in_title/first_seen get
-- the group's aggregate. Order matters: dedup → index → trigger.
UPDATE event_entities a SET in_title = t.any_title, first_seen_at = t.first_seen
FROM (
  SELECT event_id, entity_id, bool_or(in_title) AS any_title,
         min(first_seen_at) AS first_seen
  FROM event_entities WHERE entity_id IS NOT NULL
  GROUP BY event_id, entity_id
) t
WHERE a.event_id = t.event_id AND a.entity_id = t.entity_id;
DELETE FROM event_entities a USING event_entities b
WHERE a.event_id = b.event_id
  AND a.entity_id = b.entity_id
  AND a.entity_id IS NOT NULL
  AND (b.in_title > a.in_title
       OR (b.in_title = a.in_title AND b.entity_slug < a.entity_slug));

CREATE UNIQUE INDEX uq_event_entities_entity
  ON event_entities (event_id, entity_id) WHERE entity_id IS NOT NULL;

-- corrections append a new assertion whose supersedes_relationship_id
-- points at the old one; UPDATE/DELETE is rejected outright.
CREATE TRIGGER entity_relationships_append_only
  BEFORE UPDATE OR DELETE ON entity_relationships
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
