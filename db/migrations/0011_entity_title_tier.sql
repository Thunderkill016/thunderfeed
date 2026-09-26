BEGIN;

-- 0011: headline vs mention relevance — the junction gains the tier
-- split the resolver already keeps (entity_signature vs
-- entity_signature_core). A slug is in_title when it anchored at least
-- one merged cluster's title; mention-only slugs stay peripheral.
-- Accumulate-only: mentions upgrade to headline, never downgrade.
ALTER TABLE event_entities
  ADD COLUMN in_title boolean NOT NULL DEFAULT false;
CREATE INDEX idx_event_entities_slug_title
  ON event_entities (entity_slug) WHERE in_title;

COMMIT;

-- == PG-ONLY: backfill headline flags from the stored core signature ==
BEGIN;
UPDATE event_entities ee
SET in_title = true
FROM events e
WHERE e.id = ee.event_id
  AND (' ' || coalesce(e.entity_signature_core, e.entity_signature) || ' ')
      LIKE '% ' || ee.entity_slug || ' %';
COMMIT;
