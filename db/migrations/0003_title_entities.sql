-- 0003: title-only entity signature for event identity.
-- entity_signature (title+summary) keeps corroborating compatibility;
-- summary boilerplate (wire "related news" mentions) must not mint
-- identity, so merge decisions key off title entities only.
ALTER TABLE events
  ADD COLUMN entity_signature_core text NOT NULL DEFAULT '';

COMMENT ON COLUMN events.entity_signature_core IS
  'entities extracted from the title only — identity evidence';
