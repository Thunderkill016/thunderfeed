-- 0008: edition_snapshots — the serialized Edition JSON as append-only
-- jsonb rows. Serverless read paths (Vercel) have no durable filesystem,
-- so getEdition serves the latest row here instead of .cache/edition.json.
-- Written by refreshEdition / scripts/build-edition.mts (local cron →
-- remote Postgres); read preference is fs→DB locally, DB→fs on Vercel.

BEGIN;

CREATE TABLE edition_snapshots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
