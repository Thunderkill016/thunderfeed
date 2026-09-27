-- 0036_radar_evidence_prominence.sql — R6: evidence independence + entity
-- prominence. Additive columns only; existing rows stay valid.
--
--   evidence_documents.independence_key — cluster id grouping documents
--     that carry the same wire/copy text (derived from title shingles,
--     since content_text is not collected). NULL = not yet classified;
--     readers fall back to counting distinct source_id.
--
--   event_entities.role / event_entities.prominence — how central an
--     entity is to the event. Backfilled by scripts/radar/enrich.mts:
--     'subject' (in current title), 'actor' (recurrent across evidence
--     doc titles), 'mention' (signature-only). prominence in [0,1].

ALTER TABLE evidence_documents
  ADD COLUMN IF NOT EXISTS independence_key text;

ALTER TABLE event_entities
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'mention',
  ADD COLUMN IF NOT EXISTS prominence real NOT NULL DEFAULT 0.5;

CREATE INDEX IF NOT EXISTS idx_evidence_docs_independence
  ON evidence_documents (independence_key);

CREATE INDEX IF NOT EXISTS idx_event_entities_prominence
  ON event_entities (event_id, prominence);
