-- 0009: delivery_state — small kv for outbound-channel watermarks.
-- The Telegram dedup marker used to live in data/alert-state.json, which
-- evaporates on ephemeral runners (GitHub Actions); this row persists it.

BEGIN;

CREATE TABLE delivery_state (
  channel    text        PRIMARY KEY,
  state      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
