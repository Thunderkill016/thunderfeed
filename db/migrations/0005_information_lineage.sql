-- 0005_information_lineage.sql
-- Information Lineage V1: distinguish N independent confirmations from
-- N copies of one origin. Also fixes metadata-enrichment provenance:
-- structured metadata arriving after the editorial version must merge
-- into current state with an audit trail, never mutate old versions.

-- --------------------------- change types -------------------------------
-- an attached document that forms a NEW information origin (independent
-- corroboration), as opposed to coverage inside a known lineage.
ALTER TYPE change_type ADD VALUE 'new_independent_evidence';
ALTER TYPE event_change_reason ADD VALUE 'independent_origin';

-- --------------------- document metadata observations -------------------
-- evidence_versions stays append-only editorial state. Enrichment
-- (gazette attributes, filing fields, late detail fetches) merges into
-- evidence_documents.metadata — the current richest view — and every
-- effective merge is logged here for audit.
ALTER TABLE evidence_documents
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE evidence_metadata_observations (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  document_id   uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  -- only the delta that actually changed current metadata
  delta         jsonb NOT NULL,
  -- merged result after applying delta — cheap audit without replay
  snapshot      jsonb NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meta_obs_doc ON evidence_metadata_observations (document_id);

-- ---------------------------- evidence_lineage --------------------------
-- Assertions about where a document's information ORIGINATED. Append-only:
-- a classifier that changes its mind inserts a new version, the old row is
-- never rewritten (audit = full history per document).
CREATE TYPE lineage_relation AS ENUM (
  'original',            -- evaluated, no parent found — its own origin
  'syndicated',          -- near-verbatim wire/syndication copy
  'quoted',              -- explicitly attributes another document
  'rewritten',           -- derived from a parent with material rewording
  'press_release_based', -- derived from a primary/official document
  'unknown'              -- could not be evaluated
);
CREATE TYPE lineage_method AS ENUM ('rule', 'similarity', 'model', 'manual');

CREATE TABLE evidence_lineage (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  child_document_id   uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  version_no          int NOT NULL,
  -- direct parent: the document this one copied/quoted (NULL for origins)
  parent_document_id  uuid REFERENCES evidence_documents(id) ON DELETE SET NULL,
  -- chain root: resolved ancestor, NULL = self is the root
  origin_document_id  uuid REFERENCES evidence_documents(id) ON DELETE SET NULL,
  relation            lineage_relation NOT NULL,
  confidence          real NOT NULL DEFAULT 0,
  method              lineage_method NOT NULL,
  -- signal dump: matched phrases, similarity scores, candidate ids
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_document_id, version_no)
);
CREATE INDEX idx_lineage_child ON evidence_lineage (child_document_id);
CREATE INDEX idx_lineage_parent ON evidence_lineage (parent_document_id)
  WHERE parent_document_id IS NOT NULL;
CREATE INDEX idx_lineage_origin ON evidence_lineage (origin_document_id)
  WHERE origin_document_id IS NOT NULL;
