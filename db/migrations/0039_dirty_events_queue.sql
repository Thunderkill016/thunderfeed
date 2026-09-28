-- 0039_dirty_events_queue.sql — R6.1c: durable producer→consumer hand-off.
--
-- The orchestration gap: relineage mutates evidence_lineage on OLD events
-- without touching events.last_seen_at, so adjudicate's time-based cursor
-- never re-examines them — truth changes provenance but claims stay stale.
--
-- dirty_events is a small durable work queue: a producer job enqueues the
-- affected event INSIDE the same transaction as the write that dirtied it
-- (hand-off commits atomically with the work); the consumer job drains its
-- own pending rows and marks processed_at only after its per-event unit
-- succeeds. Retry is free — re-enqueue resets processed_at to NULL.

CREATE TABLE dirty_events (
  event_id     uuid        NOT NULL REFERENCES events(id),
  job          text        NOT NULL,   -- consumer: 'adjudicate' | ...
  reason       text        NOT NULL,   -- producer: 'relineage' | 'manual'
  queued_at    timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,            -- NULL = pending
  PRIMARY KEY (event_id, job)
);
CREATE INDEX idx_dirty_events_pending ON dirty_events (job, processed_at);
