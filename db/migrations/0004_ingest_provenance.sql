-- 0004_ingest_provenance.sql
-- Provenance-aware ingestion: discovery paths per document, richer channels,
-- primary document types, per-cycle coverage telemetry.

-- Channels beyond the original ingest_channel set. Note: enum values are
-- append-only; down-migrations cannot remove them.
ALTER TYPE ingest_channel ADD VALUE 'news_sitemap';
ALTER TYPE ingest_channel ADD VALUE 'official_rss';
ALTER TYPE ingest_channel ADD VALUE 'official_api';

-- Primary document families (Công báo legal docs, SEC filings).
ALTER TYPE document_type ADD VALUE 'legal_document';
ALTER TYPE document_type ADD VALUE 'filing';

-- --------------------------- evidence_discoveries ---------------------------
-- Every channel a document has been observed through. `discovered_via` on
-- evidence_documents stays the FIRST-seen channel; this table is the full
-- provenance history. A new discovery path never mints an EvidenceVersion —
-- content hash dedup remains the only versioning gate.
CREATE TABLE evidence_discoveries (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  document_id   uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  channel       ingest_channel NOT NULL,
  -- provider is the discovery layer, never the publisher: GDELT, SEC EDGAR.
  -- '' (not NULL) keeps the unique key well-defined.
  provider      text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  external_id   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, channel, provider)
);
CREATE INDEX idx_evidence_discoveries_doc ON evidence_discoveries (document_id);
CREATE INDEX idx_evidence_discoveries_provider ON evidence_discoveries (provider)
  WHERE provider <> '';

-- ------------------------------ ingest cycles -------------------------------
-- Coverage telemetry per refresh cycle: which sources contribute
-- intelligence vs. mere volume. Written by persistEdition — absent without
-- DATABASE_URL, like the rest of the evidence layer.
CREATE TABLE ingest_cycles (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE ingest_source_stats (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  cycle_id           uuid NOT NULL REFERENCES ingest_cycles(id) ON DELETE CASCADE,
  source_key         text NOT NULL,       -- feed id / adapter id
  channel            ingest_channel,
  provider           text,
  fetched            int NOT NULL DEFAULT 0,
  accepted           int NOT NULL DEFAULT 0,
  duplicate_docs     int NOT NULL DEFAULT 0,
  new_evidence_versions int NOT NULL DEFAULT 0,
  events_contributed int NOT NULL DEFAULT 0,
  material_events    int NOT NULL DEFAULT 0,
  primary_attached   int NOT NULL DEFAULT 0,
  claims_confirmed   int NOT NULL DEFAULT 0,
  latency_ms         int,
  http_status        int,
  status             text NOT NULL,       -- ok|empty|rate_limited|timeout|error
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_ingest_source_stats_cycle ON ingest_source_stats (cycle_id);
CREATE INDEX idx_ingest_source_stats_key ON ingest_source_stats (source_key);
