/**
 * R7.1d.3b.2 — reviewed doc×event gold join for the poisoning bench.
 *
 * The attachment corpus labels claims per event; each claim carries
 * standing-evidence docs. An (event, evidence-version) edge inherits the
 * strongest claim class backing it — a doc behind a misclustered claim is
 * a foreign attachment even if it also backs an on-topic claim, because
 * the on-topic attribution is itself the miscluster.
 */

export type EdgeGold = "driver" | "on_topic" | "misclustered" | "unreviewed";

export interface LabelEvent {
  eventId: string;
  claims: Record<string, string>;
}
export interface CorpusEvent {
  eventId: string;
  claims: {
    claimId: string;
    standingEvidence: { evidenceVersionId: string }[];
  }[];
}

const RANK: Record<EdgeGold, number> = {
  misclustered: 3,
  driver: 2,
  on_topic: 1,
  unreviewed: 0,
};

export function buildEdgeGold(
  labels: { events: LabelEvent[] },
  corpus: { events: CorpusEvent[] },
): Map<string, EdgeGold> {
  const labelByClaim = new Map<string, string>();
  for (const ev of labels.events)
    for (const [cid, cls] of Object.entries(ev.claims))
      labelByClaim.set(`${ev.eventId}|${cid}`, cls);
  const gold = new Map<string, EdgeGold>();
  for (const ev of corpus.events) {
    for (const c of ev.claims) {
      const cls = labelByClaim.get(`${ev.eventId}|${c.claimId}`);
      const g: EdgeGold =
        cls === "misclustered"
          ? "misclustered"
          : cls === "driver"
            ? "driver"
            : cls === "on_topic_non_driver"
              ? "on_topic"
              : "unreviewed";
      if (g === "unreviewed") continue;
      for (const s of c.standingEvidence) {
        const key = `${ev.eventId}|${s.evidenceVersionId}`;
        const cur = gold.get(key);
        if (!cur || RANK[g] > RANK[cur]) gold.set(key, g);
      }
    }
  }
  return gold;
}
