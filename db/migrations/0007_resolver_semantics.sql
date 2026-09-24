-- 0007: resolver semantics — durable event embedding cache + decision
-- telemetry for the two-stage resolver.
--
-- event_embeddings: cached semantic vectors keyed by the event's
-- representation hash — when the representation text changes the hash
-- changes and a new row is written (history preserved, never overwrite).
-- Vectors are plain jsonb — the active candidate set is small enough to
-- score cosine in Node; pgvector is a later swap target.
--
-- resolver_decisions: per-evaluation audit. When the resolver is wrong
-- in production we can see exactly which path fired and which features
-- it saw. Append-only.

CREATE TABLE event_embeddings (
  event_id            uuid NOT NULL REFERENCES events(id),
  representation_hash text NOT NULL,
  model               text NOT NULL,
  dims                int  NOT NULL,
  vector              jsonb NOT NULL,
  representation      text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, representation_hash)
);
CREATE INDEX idx_event_embeddings_event ON event_embeddings (event_id);

CREATE TABLE resolver_decisions (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  incoming_cluster     text,
  candidate_event_id   uuid REFERENCES events(id),
  chosen_event_id      uuid REFERENCES events(id),
  decision             text NOT NULL,     -- merge | split | ambiguous
  path                 text NOT NULL,     -- which rule produced it
  score                double precision,
  reasons              jsonb NOT NULL DEFAULT '[]',
  hard_blocks          jsonb NOT NULL DEFAULT '[]',
  features             jsonb NOT NULL DEFAULT '{}',
  semantic_available   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_resolver_decisions_event ON resolver_decisions (candidate_event_id);
CREATE INDEX idx_resolver_decisions_time ON resolver_decisions (created_at);

-- == PG-ONLY: telemetry is audit — append-only like history tables ==
CREATE TRIGGER resolver_decisions_append_only
  BEFORE UPDATE OR DELETE ON resolver_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
