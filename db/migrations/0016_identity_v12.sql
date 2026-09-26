BEGIN;

-- 0016: identity V1.2 — mention-surface provenance + projection docs.
--
-- (a) matched_slug records WHICH gazetteer slug produced a row, closing
--     the information loss that forced 0014 to re-point blindly. From
--     here: surface → matched_slug → canonical entity → auditable
--     assertion, reconstructible without guessing from entity_id.
-- (b) evidence_entities rows with method='gazetteer' are a DERIVED
--     PROJECTION of EvidenceVersion text — rebuildable and removable by
--     reconciliation. EvidenceVersion is the immutable history; the
--     projection is not. Structured methods (structured_cik,
--     structured_issuer, structured_coquan, source_publisher) remain
--     provenance assertions and are never rebuilt by reconciliation.
-- (c) Phase-3 corrective record: 0014 contained a data-repair statement
--     that moved ALL gazetteer rows on company:alphabet to brand:google
--     regardless of the matched surface — a blind re-point caused by
--     the missing slug information (fixed structurally here). Data
--     repair is NOT repeated in migrations: the source of truth after
--     V1.2 is reconciliation from EvidenceVersion text
--     (scripts/reconcile-evidence-entities.mts), so no fresh install
--     ever performs a canonical-key-level re-point of derived rows
--     again. 0014 stays in the chain untouched (applied migrations are
--     immutable); the reconciliation corrects the rows it produced.

ALTER TABLE evidence_entities
  ADD COLUMN matched_slug text;

COMMENT ON COLUMN evidence_entities.matched_slug IS
  'Gazetteer slug whose surface produced this assertion (method=gazetteer only). Makes surface → slug → entity explainable; NULL for structured issuer methods.';

COMMENT ON TABLE evidence_entities IS
  'Mention-level entity provenance. method=gazetteer rows are a DERIVED PROJECTION of EvidenceVersion text — rebuildable/removable by reconcile-evidence-entities.mts. method=structured_* rows are provenance assertions from document metadata — never rebuilt. EvidenceVersion itself is immutable history.';

COMMIT;
