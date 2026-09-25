BEGIN;

-- 0010: canonical entity rows — the ontology-graph projection.
-- events.entity_signature stays the resolver's working truth (the
-- contradiction guard accumulates a space-joined slug string); this
-- junction exposes the same slugs as queryable rows so entity-level
-- reads ("every event mentioning 'fed'") never explode a text column.
-- Rows are append-only accumulations, mirroring signature semantics:
-- a slug joins when first observed on the event and is never removed.
CREATE TABLE event_entities (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_slug   text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, entity_slug)
);
-- the read path fans out by slug (watch topics, entity pages)
CREATE INDEX idx_event_entities_slug ON event_entities (entity_slug);
COMMIT;

-- == PG-ONLY: backfill is a data migration — pg-mem fixtures create fresh
-- events through the writer, which maintains the junction from row one ==
BEGIN;
INSERT INTO event_entities (event_id, entity_slug)
SELECT e.id, s.slug
FROM events e
CROSS JOIN LATERAL unnest(string_to_array(e.entity_signature, ' ')) AS s(slug)
ON CONFLICT DO NOTHING;
COMMIT;
