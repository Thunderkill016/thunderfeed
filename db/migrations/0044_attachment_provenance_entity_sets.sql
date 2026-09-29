-- 0044_attachment_provenance_entity_sets.sql — R7.1d.3b.1a: entity-set
-- provenance for signature-poisoning counterfactuals.
--
-- 0043 stored hash + counts of the candidate's PRE-merge signature.
-- Audit verdict: hash+count cannot distinguish "this anchor was the
-- founding identity" from "this anchor entered via contamination merge
-- #12" — the stable-anchor counterfactual (3b.2 candidate D) needs the
-- actual entity SETS on both sides of the attachment. Sorted arrays are
-- small (entity signatures are tens of slugs, not thousands).
--
--   candidate_entities_before      — full entity_signature, pre-union
--   candidate_core_entities_before — entity_signature_core, pre-union
--   incoming_entities              — incoming cluster's entity set
--   incoming_core_entities         — incoming cluster's core entity set
--
-- NULLABLE on purpose: pre-0044 rows keep NULL = "not captured", which
-- must stay distinguishable from a verified-empty set ([]).

ALTER TABLE event_attachment_provenance
  ADD COLUMN candidate_entities_before      jsonb,
  ADD COLUMN candidate_core_entities_before jsonb,
  ADD COLUMN incoming_entities              jsonb,
  ADD COLUMN incoming_core_entities         jsonb;

COMMIT;
