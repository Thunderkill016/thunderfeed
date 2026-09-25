/**
 * Canonical change grouping — one change row per evidence version means a
 * single event can emit many near-identical rows (one per confirming
 * source). Both surfaces that render changes — the web rail and the
 * Telegram digest — share this dedup + per-event grouping so coverage
 * collapses to "N nguồn" instead of spamming one card/line per source.
 */

export interface ChangeLike {
  eventId?: string;
  eventTitle: string;
  type: string;
  materiality: string;
  summary: string;
  detectedAt: string;
}

export const MATERIALITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** change types that mean "another source confirmed" — collapse into one
 *  source-count per event instead of one line/card per source */
export const COVERAGE_TYPES = new Set([
  "new_independent_evidence",
  "new_coverage",
]);

export interface EventChangeGroup {
  /** eventId when present, else the event title — the grouping key */
  key: string;
  eventId?: string;
  eventTitle: string;
  /** worst→best materiality rank across the group's changes (0 = high) */
  rank: number;
  /** epoch ms of the newest change in the group */
  latest: number;
  /** deduped changes in arrival order */
  items: ChangeLike[];
  /** non-coverage changes — real deltas */
  substantive: ChangeLike[];
  /** distinct source names extracted from coverage summaries */
  coverageSources: string[];
}

/** Drop exact-duplicate rows — several evidence versions of one article
 *  emit identical (event, type, summary) triples. */
export function dedupChanges(changes: ChangeLike[]): ChangeLike[] {
  const seen = new Set<string>();
  const out: ChangeLike[] = [];
  for (const c of changes) {
    const k = `${c.eventId ?? c.eventTitle}|${c.type}|${c.summary}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** "…xác nhận: Source" / "…đưa tin: Source" — keep the source name. */
function coverageSource(summary: string): string {
  const m = summary.match(/:\s*([^:]+)$/);
  return m?.[1]?.trim() ?? summary;
}

export function groupChangesByEvent(changes: ChangeLike[]): EventChangeGroup[] {
  const groups = new Map<string, EventChangeGroup>();
  for (const c of dedupChanges(changes)) {
    const key = c.eventId ?? c.eventTitle;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        eventId: c.eventId,
        eventTitle: c.eventTitle,
        rank: 9,
        latest: 0,
        items: [],
        substantive: [],
        coverageSources: [],
      };
      groups.set(key, g);
    }
    g.items.push(c);
    g.rank = Math.min(g.rank, MATERIALITY_ORDER[c.materiality] ?? 1);
    g.latest = Math.max(g.latest, Date.parse(c.detectedAt) || 0);
    if (COVERAGE_TYPES.has(c.type)) {
      const src = coverageSource(c.summary);
      if (!g.coverageSources.includes(src)) g.coverageSources.push(src);
    } else {
      g.substantive.push(c);
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.rank - b.rank || b.latest - a.latest,
  );
}

/** Display materiality class for a group rank — matches the card/badge
 *  CSS classes ("high" | "medium" | "low"). */
export function materialityName(rank: number): string {
  return rank === 0 ? "high" : rank === 1 ? "medium" : "low";
}

/* ------------------------- story arc (catch-up) ------------------------- */

/** Minimal shape the arc needs — satisfied by both ChangeLike and the
 *  per-event ChangeView rows the modal fetches. */
export interface ArcChange {
  type: string;
  materiality?: string;
  summary: string;
  detectedAt: string;
}

export interface ArcDay {
  /** "Th 5, 25/9" — Vietnam-local day boundary, not UTC */
  label: string;
  items: ArcChange[];
}

const DAY_FMT = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  weekday: "short",
  day: "numeric",
  month: "numeric",
});

/**
 * One event's change log as a reading arc: deduplicated, oldest→newest,
 * grouped under Vietnam-local day headers. A reader arriving on day 3
 * catches up top-down instead of reverse-engineering a newest-first log.
 */
export function buildStoryArc(changes: ArcChange[]): ArcDay[] {
  const seen = new Set<string>();
  const sorted = changes
    .filter((c) => {
      const k = `${c.type}|${c.summary}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(
      (a, b) =>
        (Date.parse(a.detectedAt) || 0) - (Date.parse(b.detectedAt) || 0),
    );
  const days: ArcDay[] = [];
  for (const c of sorted) {
    const label = DAY_FMT.format(new Date(c.detectedAt));
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(c);
    else days.push({ label, items: [c] });
  }
  return days;
}

/** Summary text for a substantive change — the writer already prefixes
 *  some summaries with the change label ("Dữ kiện mới: 519 triệu USD"),
 *  so surfaces adding their own label must strip the duplicate. */
export function changeSummaryText(c: ChangeLike, label: string): string {
  return c.summary.startsWith(`${label}:`)
    ? c.summary.slice(label.length + 1).trim()
    : c.summary;
}
