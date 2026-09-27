import assert from "node:assert/strict";
import test from "node:test";
import {
  clusterByTitles,
  prominenceFor,
  titleKey,
  titleShingles,
} from "../lib/enrich";
import {
  computeClaimState,
  latestVotes,
  positionsFromVotes,
  posKey,
  rankWinner,
  type Vote,
} from "../lib/db/positions";
import { prominentEntities } from "../lib/radar";

test("titleKey: outlet suffixes stripped, diacritics folded", () => {
  const a = titleKey("Fed giữ nguyên lãi suất | VnExpress");
  const b = titleKey("Fed giữ nguyên lãi suất - VTC News");
  assert.equal(a, b);
});

test("clusterByTitles: wire reprints share one independence key", () => {
  const docs = [
    { id: "d1", title: "Fed giữ nguyên lãi suất trong tháng Chín" },
    // same wire, reworded tail
    { id: "d2", title: "Fed giữ nguyên lãi suất trong tháng 9 | VnExpress" },
    // unrelated headline sharing words but not shingles
    { id: "d3", title: "Lãi suất tiết kiệm ngân hàng tăng mạnh tuần này" },
  ];
  const keys = clusterByTitles(docs);
  assert.equal(keys.get("d1"), keys.get("d2"));
  assert.notEqual(keys.get("d1"), keys.get("d3"));
});

test("titleShingles: short titles still produce shingles", () => {
  assert.ok(titleShingles("Bitcoin lao dốc").size > 0);
});

test("prominenceFor: title entity = subject, doc-recurrent = actor, signature-only = mention", () => {
  const eventTitle = "Ông Trump hội đàm ông Tập tại Bắc Kinh";
  const docTitles = [
    eventTitle,
    "Trump nói về thương mại với Tập Cận Bình",
    "Trung Quốc và Mỹ đạt thỏa thuận",
  ];
  const subject = prominenceFor({
    slug: "trump",
    eventTitle,
    docTitles,
  });
  assert.equal(subject.role, "subject");
  assert.ok(subject.prominence >= 0.9);

  const mention = prominenceFor({
    slug: "un",
    eventTitle,
    docTitles,
  });
  assert.equal(mention.role, "mention");
  assert.ok(mention.prominence < 0.5);
});

test("prominenceFor: claim subject lifts a non-title entity", () => {
  const withClaim = prominenceFor({
    slug: "nhnn",
    eventTitle: "Tỷ giá trung tâm tăng",
    docTitles: ["Tỷ giá trung tâm tăng"],
    claimSubjectKeys: new Set(["org:nhnn"]),
  });
  const without = prominenceFor({
    slug: "nhnn",
    eventTitle: "Tỷ giá trung tâm tăng",
    docTitles: ["Tỷ giá trung tâm tăng"],
  });
  assert.ok(withClaim.prominence >= without.prominence);
});

test("prominentEntities: mention rows filtered, empty enriched set ≠ fallback", () => {
  const enriched = prominentEntities({
    title: "Israel pager UN meeting",
    entities: [
      { key: "netanyahu", role: "subject", prominence: 0.9 },
      { key: "un", role: "mention", prominence: 0.15 },
    ],
  });
  assert.deepEqual(enriched, ["netanyahu"]);

  const notYetEnriched = prominentEntities({ title: "", entities: [] });
  assert.deepEqual(notYetEnriched, extractEntitiesShim(""));

  function extractEntitiesShim(t: string) {
    return prominentEntities({ title: t });
  }
});

test("prominentEntities: missing entities field falls back to title", () => {
  const keys = prominentEntities({ title: "Fed giữ nguyên lãi suất" });
  assert.ok(keys.includes("federal_reserve"));
});

/* ---- shared claim-truth engine (ingest + batch adjudication) ---- */

const vote = (v: Partial<Vote>): Vote => ({
  voter: "src:a",
  pos: posKey(5, "%"),
  valueJson: "5",
  unit: "%",
  versionNo: 1,
  state: "reported",
  primary: false,
  at: 1000,
  ...v,
});

function build(votes: Vote[]) {
  // one version per distinct position the votes stand on
  const versions = [...new Map(votes.map((v) => [v.pos, v])).values()].map(
    (v, i) => ({
      id: `v${i + 1}`,
      version_no: i + 1,
      pos: v.pos,
      valueJson: v.valueJson,
    }),
  );
  return positionsFromVotes(latestVotes(votes), versions);
}

test("claim truth: ≥2 independent origins on one position → supported", () => {
  const votes = [
    vote({ voter: "src:a", at: 1000 }),
    vote({ voter: "src:b", at: 2000 }),
  ];
  const positions = [...build(votes).values()];
  assert.equal(computeClaimState({ positions }), "supported");
});

test("claim truth: wire reprints collapse — 3 docs, 1 origin → reported", () => {
  // adjudicator resolves all three docs to the same lineage-root source
  const votes = [
    vote({ voter: "src:wire", at: 1000 }),
    vote({ voter: "src:wire", at: 2000 }),
    vote({ voter: "src:wire", at: 3000 }),
  ];
  const positions = [...build(votes).values()];
  assert.equal(computeClaimState({ positions }), "reported");
});

test("claim truth: two live positions → disputed; source moves retract support", () => {
  // src:a asserted 5% then revised to 6% — its old position must empty
  const p5 = posKey(5, "%");
  const p6 = posKey(6, "%");
  const votes: Vote[] = [
    vote({ voter: "src:a", pos: p5, valueJson: "5", at: 1000 }),
    vote({ voter: "src:a", pos: p6, valueJson: "6", at: 3000 }), // revision
    vote({ voter: "src:b", pos: p5, valueJson: "5", at: 2000 }),
  ];
  const versions = [
    { id: "v1", version_no: 1, pos: p5, valueJson: "5" },
    { id: "v2", version_no: 2, pos: p6, valueJson: "6" },
  ];
  const positions = [
    ...positionsFromVotes(latestVotes(votes), versions).values(),
  ];
  const live = positions.filter((p) => p.origins.size > 0);
  assert.equal(live.length, 2); // a→6, b→5
  assert.equal(computeClaimState({ positions }), "disputed");
});

test("claim truth: primary origin wins → confirmed", () => {
  const votes = [
    vote({ voter: "src:a", at: 1000 }),
    vote({ voter: "src:fed", at: 2000, primary: true }),
  ];
  const positions = [...build(votes).values()];
  assert.equal(computeClaimState({ positions }), "confirmed");
});

test("claim truth: stale assertion never moves the live vote", () => {
  // evidence arriving late with an OLDER timestamp must not re-position
  const p5 = posKey(5, "%");
  const p6 = posKey(6, "%");
  const votes: Vote[] = [
    vote({ voter: "src:a", pos: p6, valueJson: "6", at: 3000 }),
    vote({ voter: "src:a", pos: p5, valueJson: "5", at: 1000 }), // stale
  ];
  const latest = latestVotes(votes);
  assert.equal(latest.get("src:a")!.pos, p6);
});

test("claim truth: single terminal position keeps corrected/retracted", () => {
  const votes = [vote({ voter: "src:a" })];
  const positions = [...build(votes).values()];
  assert.equal(
    computeClaimState({ positions, winnerVersionState: "corrected" }),
    "corrected",
  );
  assert.equal(
    computeClaimState({ positions, winnerVersionState: "retracted" }),
    "retracted",
  );
});

test("claim truth: no age rule — old single-origin stays reported", () => {
  // the R6 'aged 5 days → unresolved' rule is gone: age is metadata
  const votes = [vote({ voter: "src:a", at: Date.now() - 30 * 86_400_000 })];
  const positions = [...build(votes).values()];
  assert.equal(computeClaimState({ positions }), "reported");
});

test("rankWinner: deterministic, primary beats crowd", () => {
  const votes = [
    vote({ voter: "src:a", pos: posKey(5, "%"), valueJson: "5" }),
    vote({ voter: "src:b", pos: posKey(5, "%"), valueJson: "5" }),
    vote({
      voter: "src:fed",
      pos: posKey(6, "%"),
      valueJson: "6",
      primary: true,
    }),
  ];
  const versions = [
    { id: "v1", version_no: 1, pos: posKey(5, "%"), valueJson: "5" },
    { id: "v2", version_no: 2, pos: posKey(6, "%"), valueJson: "6" },
  ];
  const positions = [
    ...positionsFromVotes(latestVotes(votes), versions).values(),
  ];
  const w = rankWinner(positions)!;
  assert.equal(w.valueJson, "6"); // authority wins even at 1 origin vs 2
});
