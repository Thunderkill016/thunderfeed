/* R6 enrichment primitives — deterministic, no AI.
 *
 *   titleKey / titleShingles / clusterByTitles — wire-copy detection.
 *     evidence_versions.content_text is not collected, so independence is
 *     measured on normalized TITLE shingles: two outlets reprinting one
 *     wire end up in the same independence group, and
 *     independentSourceCount = count(distinct group) per event.
 *
 *   prominenceFor — how central an entity is to an event. The resolver's
 *     entity_signature is a union over ALL evidence (30+ slugs, mostly
 *     mentions); prominence separates "the event is about X" from
 *     "X is mentioned once".
 */
import { normalizeText } from "./model";
import { canonicalKeyForSlug, extractEntities } from "./entities";

/** fnv1a-32 — small deterministic hash for cluster keys. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* Outlet/branding suffixes Vietnamese publishers append to the wire
 * title — stripped before shingling so "… | VnExpress" and "… - VTC News"
 * copies still cluster together. */
/* requires a - – | separator before the outlet name so a title that
 * *starts* with a brand word ("CafeF ra mắt…") is never eaten */
const OUTLET_SUFFIX =
  /\s*[-–|]\s*(vnexpress|vtc|vtv|tuoitre|thanhnien|dantri|vietnamnet|cafef|cafeland|zingnews|kenh14|soha|bao\s*chinh\s*phu|nhandan|tienphong|laodong|nld|plo|phapluat|congan|qdnd|nhipsongkinhte|thoibaonganhang|congluan|vietnamfinance|vietnambiz|thethaovanhoa|anninhthudo|doisongphapluat|giaoduc|suckhoedoisong|techz|genk|autopro|reuters|afp|ap|bloomberg|bbc|cnn|cnbc|nikkei|scmp|straitstimes|channel\s*news\s*asia|the\s*guardian|financial\s*times|wsj|al\s*jazeera|france\s*24|dw|rt|tass|kyodo|yohnap|xinhua)[^|–-]*$/i;

/** Normalized headline minus outlet decoration — the clustering surface. */
export function titleKey(title: string): string {
  return normalizeText(title.replace(OUTLET_SUFFIX, ""));
}

/** Word n-gram shingles over the normalized title (3-grams, plus the
 *  2-gram set for short headlines so a 4-word wire title still matches). */
export function titleShingles(title: string): Set<string> {
  const words = titleKey(title).split(" ").filter(Boolean);
  const out = new Set<string>();
  const n = words.length >= 6 ? 3 : 2;
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  if (out.size === 0 && words.length) out.add(words.join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Two headlines are the same wire when ≥60% of their shingles overlap —
 *  calibrated against the corpus: localized reprints keep entity/proper-
 *  noun shingles even when the outlet rewrites glue words. */
export const WIRE_SIMILARITY = 0.6;

export interface TitledDoc {
  id: string;
  title: string;
  /** earliest first — used to pick the cluster leader deterministically */
  publishedAt?: string;
}

/** Group docs carrying the same wire text. Returns docId → cluster key.
 *  Union-find over pairwise Jaccard; cluster key is the fnv1a hash of the
 *  leader's normalized title so the same wire gets the same key wherever
 *  it appears. */
export function clusterByTitles(docs: TitledDoc[]): Map<string, string> {
  const sorted = [...docs].sort(
    (a, b) =>
      String(a.publishedAt ?? "").localeCompare(String(b.publishedAt ?? "")) ||
      a.id.localeCompare(b.id),
  );
  const shingles = sorted.map((d) => titleShingles(d.title));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (jaccard(shingles[i], shingles[j]) >= WIRE_SIMILARITY) {
        parent[find(i)] = find(j);
      }
    }
  }
  const out = new Map<string, string>();
  const leaderKey = new Map<number, string>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    if (!leaderKey.has(root)) {
      leaderKey.set(root, `i${fnv1a(titleKey(sorted[i].title))}`);
    }
    out.set(sorted[i].id, leaderKey.get(root)!);
  }
  return out;
}

/* ------------------------- entity prominence ------------------------- */

export type EntityRole = "subject" | "actor" | "mention";

export interface EntityProminence {
  role: EntityRole;
  prominence: number;
}

/** Slug present in ≥40% of an event's evidence headlines is an actor the
 *  coverage keeps returning to; present in the current event title it is
 *  the subject; signature-only (never in any headline) is a mention. */
const ACTOR_DOC_SHARE = 0.4;
const MENTION_DOC_SHARE = 0.1;
const CLAIM_SUBJECT_BOOST = 0.15;

export function prominenceFor(opts: {
  slug: string;
  eventTitle: string;
  /** evidence-document headlines attached to the event */
  docTitles: string[];
  /** canonical keys ('person:donald_trump') of entities that are the
   *  subject of ≥1 claim on this event */
  claimSubjectKeys?: Set<string>;
}): EntityProminence {
  const { slug, eventTitle, docTitles, claimSubjectKeys } = opts;
  const inTitle = extractEntities(eventTitle).includes(slug);
  let docHits = 0;
  for (const t of docTitles) {
    if (extractEntities(t).includes(slug)) docHits++;
  }
  const share = docTitles.length ? docHits / docTitles.length : 0;
  const key = canonicalKeyForSlug(slug);
  const claimBoost =
    key && claimSubjectKeys?.has(key) ? CLAIM_SUBJECT_BOOST : 0;

  if (inTitle) {
    return {
      role: "subject",
      prominence: Math.min(1, 0.9 + claimBoost),
    };
  }
  if (share >= ACTOR_DOC_SHARE) {
    return {
      role: "actor",
      prominence: Math.min(1, 0.7 + claimBoost),
    };
  }
  if (docHits > 0) {
    return {
      role: "mention",
      prominence: Math.min(0.35, 0.15 + share + claimBoost),
    };
  }
  return { role: "mention", prominence: Math.min(0.3, 0.15 + claimBoost) };
}
