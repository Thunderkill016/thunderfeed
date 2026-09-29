-- 0043_resolver_attachment_provenance.sql — R7.1d.3b.1: doc-level resolver
-- attachment provenance telemetry.
--
-- R7.1d.3a proved WHAT is wrong (728 misclustered claims, 84% of xlang
-- contamination riding broad doc-spray). This table answers the doc-grain
-- question the corpus cannot: WHY did document D enter event E?
-- event_evidence.attached_by='semantic' on every row erases attribution;
-- provenance links each attachment edge to the resolver_decisions row that
-- created it, with the pair features + PRE-DECISION candidate signature
-- state needed for offline counterfactual replay (R7.1d.3b.2).
--
-- Invariants:
--   * written in the SAME transaction as the event_evidence attach —
--     an attachment can never exist without its explanation
--   * append-only audit — one decision attaching N docs yields N edges
--     all pointing at the same resolver_decision_id
--   * founding docs of a created event get path='create_new_event' via a
--     synthetic decision='create' row — never the generic 'semantic' label
--   * pre-decision signature fields are frozen at attach time: the
--     entity_signature merge that follows this attach can never rewrite
--     what the resolver actually saw
--
-- No threshold or merge-path behavior changes in this phase.

CREATE TABLE event_attachment_provenance (
  id                                uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id                          uuid NOT NULL REFERENCES events(id),
  evidence_version_id               uuid NOT NULL REFERENCES evidence_versions(id),
  -- the pair decision that attached this doc; for a newly-created event
  -- this is the synthetic decision='create' row, never NULL
  resolver_decision_id              uuid NOT NULL REFERENCES resolver_decisions(id),
  decision                          text NOT NULL,      -- merge | create
  path                              text NOT NULL,      -- resolver rule that fired
  incoming_cluster                  text,
  candidate_event_id                uuid REFERENCES events(id),
  score                             double precision,
  lexical_score                     double precision,
  entity_score                      double precision,
  generic_claim_overlap             double precision,
  rare_token_count                  integer,
  rare_tokens                       jsonb NOT NULL DEFAULT '[]',
  shared_entity_count               integer,
  shared_entities                   jsonb NOT NULL DEFAULT '[]',
  shared_nonhub_entity_count        integer,
  shared_nonhub_entities            jsonb NOT NULL DEFAULT '[]',
  cross_language                    boolean,
  -- signature-poisoning forensics: what the candidate looked like BEFORE
  -- this merge accumulated the incoming signature into it
  candidate_signature_hash_before   text,
  candidate_entity_count_before     integer,
  candidate_core_entity_count_before integer,
  -- full pair-feature payload for counterfactual replay
  explanation                       jsonb NOT NULL DEFAULT '{}',
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, evidence_version_id, resolver_decision_id)
);
CREATE INDEX idx_attach_prov_event
  ON event_attachment_provenance (event_id);
CREATE INDEX idx_attach_prov_decision
  ON event_attachment_provenance (resolver_decision_id);
CREATE INDEX idx_attach_prov_path
  ON event_attachment_provenance (path, created_at);
CREATE INDEX idx_attach_prov_evidence
  ON event_attachment_provenance (evidence_version_id);

-- == PG-ONLY: audit trail — append-only + RLS (skipped by pg-mem) ==
CREATE TRIGGER event_attachment_provenance_append_only
  BEFORE UPDATE OR DELETE ON event_attachment_provenance
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE event_attachment_provenance ENABLE ROW LEVEL SECURITY;

COMMIT;
