/**
 * Ingest-domain provenance types. Source (publisher) and Discovery (how WE
 * found the document) are separate axes — a VOV article found via GDELT keeps
 * source=VOV; GDELT only ever appears as discoveryProvider.
 */

export type DiscoveryChannel =
  | "rss"
  | "news_sitemap"
  | "gdelt"
  | "official_rss"
  | "official_api"
  | "crawler"
  | "hn"
  | "manual";

export type SourceKind = "primary" | "publisher" | "community" | "aggregator";

export interface IngestMetadata {
  sourceKind: SourceKind;
  discoveredVia: DiscoveryChannel;
  /** discovery layer only — GDELT, SEC EDGAR. Never the publisher. */
  discoveryProvider?: string;
  sourceDomain?: string;
  /** upstream identifier: accession number, gazette number, HN id… */
  externalId?: string;
  documentType?: string;
  /** when the SOURCE last changed the document (vs when we saw it) */
  sourceUpdatedAt?: string;
  /** preserved structured payload: filing metadata, gazette attributes… */
  structuredData?: Record<string, unknown>;
}
