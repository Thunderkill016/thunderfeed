import mediaDataRaw from "../data/media_data.json";
import vnMediaRaw from "../data/vn_media.json";
import { PRIVATE_TYPOLOGIES, STATE_TYPOLOGIES } from "./model";

/**
 * Source-ownership registry. Entries from kagisearch/kite-public
 * `media_data.json` (MIT — see data/KITE_LICENSE.txt) plus hand-written
 * Vietnamese outlets in data/vn_media.json (kite's dataset has none).
 */

export interface MediaInfo {
  organization: string;
  country: string;
  owner: string;
  typology: string;
  description: string;
  /** registered domains — the publisher's canonical identity domains */
  domains: string[];
}

interface RawMediaEntry {
  country?: string;
  organization?: string;
  domains?: string[];
  description?: string;
  owner?: string;
  typology?: string;
}

const byDomain = new Map<string, MediaInfo>();
const byName = new Map<string, MediaInfo>();

function register(entry: RawMediaEntry) {
  if (!entry.organization || !entry.domains?.length) return;
  const info: MediaInfo = {
    organization: entry.organization,
    country: entry.country ?? "",
    owner: entry.owner ?? "",
    typology: entry.typology ?? "",
    description: entry.description ?? "",
    domains: entry.domains ?? [],
  };
  for (const domain of entry.domains) {
    byDomain.set(domain.toLowerCase(), info);
  }
  byName.set(entry.organization.toLowerCase(), info);
}

for (const entry of mediaDataRaw as RawMediaEntry[]) register(entry);
// VN entries win over any kite collision.
for (const entry of vnMediaRaw as RawMediaEntry[]) register(entry);

/** Try source name first (our feeds carry outlet names), then domain match. */
export function mediaInfoFor(
  sourceName: string,
  url?: string,
): MediaInfo | null {
  const byNameHit = byName.get(sourceName.toLowerCase());
  if (byNameHit) return byNameHit;
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      const hit = byDomain.get(host);
      if (hit) return hit;
      // subdomain parent: en.vneconomy.vn → vneconomy.vn
      const parts = host.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        const parentHit = byDomain.get(parent);
        if (parentHit) return parentHit;
      }
    } catch {
      /* invalid url — no lookup */
    }
  }
  return null;
}

/**
 * Canonical publisher identity for a given name/url pair. Resolves through
 * the ownership registry (organization is the canonical key); falls back to
 * the raw name. Discovery providers are never returned — GDELT/EDGAR only
 * exist on the document's discovery provenance, not as a source.
 */
export function canonicalSourceName(name: string, url?: string): string {
  return mediaInfoFor(name, url)?.organization ?? name.trim();
}

export type OwnershipClass = "state" | "private" | "unknown";

export function ownershipClass(typology: string): OwnershipClass {
  // typology→class vocabulary lives in model.ts (client-safe module) so
  // readers and the pipeline classify a source identically
  if (STATE_TYPOLOGIES.has(typology)) return "state";
  if (PRIVATE_TYPOLOGIES.has(typology)) return "private";
  return "unknown";
}
