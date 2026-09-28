-- 0040_dirty_events_generation.sql — R6.1d: generation-safe ack.
--
-- Lost-wakeup race in R6.1c: consumer reads dirty X, starts work; a
-- producer re-enqueues X (processed_at=NULL, newer work); the old
-- consumer's ack sets processed_at=now() — acknowledging work it never
-- saw. (event_id, job) identity alone cannot distinguish the unit of
-- work that was read from a newer one enqueued mid-flight.
--
-- generation is bumped on every re-enqueue; the consumer binds its ack
-- to the generation it read. Ack of a stale generation updates 0 rows,
-- so the newer unit stays pending.

ALTER TABLE dirty_events
  ADD COLUMN generation bigint NOT NULL DEFAULT 1;
