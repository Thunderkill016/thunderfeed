BEGIN;

-- Resolver hardening: distinctive entity terms per event.
-- The merge decision needs a contradiction check ("japan" vs "indonesia"
-- must never merge on a shared generic claim like `deaths`), and that
-- requires the event's entity signature persisted alongside `signature`.
ALTER TABLE events
  ADD COLUMN entity_signature text NOT NULL DEFAULT '';

COMMENT ON COLUMN events.entity_signature IS
  'Sorted space-joined canonical entity slugs (places/orgs/people). Accumulates as new evidence joins.';

COMMIT;
