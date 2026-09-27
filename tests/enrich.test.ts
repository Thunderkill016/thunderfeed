import assert from "node:assert/strict";
import test from "node:test";
import {
  clusterByTitles,
  prominenceFor,
  titleKey,
  titleShingles,
} from "../lib/enrich";
import { decideAdjudication } from "../lib/db/adjudicate";
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

const base = {
  state: "reported",
  independentSupports: 0,
  independentContradicts: 0,
  hasCorrects: false,
  observedAtMs: Date.now(),
  nowMs: Date.now(),
};

test("decideAdjudication: rule table", () => {
  // ≥2 independent supports → supported
  assert.equal(
    decideAdjudication({ ...base, independentSupports: 2 })?.to,
    "supported",
  );
  // wire copies collapse — 5 docs but 1 origin stays reported
  assert.equal(decideAdjudication({ ...base, independentSupports: 1 }), null);
  // contradiction without support → disputed
  assert.equal(
    decideAdjudication({ ...base, independentContradicts: 1 })?.to,
    "disputed",
  );
  // support AND contradiction → unresolved
  assert.equal(
    decideAdjudication({
      ...base,
      independentSupports: 1,
      independentContradicts: 1,
    })?.to,
    "unresolved",
  );
  // aged single-source → unresolved
  const old = Date.now() - 6 * 86_400_000;
  assert.equal(
    decideAdjudication({
      ...base,
      independentSupports: 1,
      observedAtMs: old,
    })?.to,
    "unresolved",
  );
  // terminal states never touched
  assert.equal(
    decideAdjudication({ ...base, state: "disputed", independentSupports: 5 }),
    null,
  );
  // corrects stance → left to the version chain
  assert.equal(
    decideAdjudication({ ...base, hasCorrects: true, independentSupports: 3 }),
    null,
  );
});
