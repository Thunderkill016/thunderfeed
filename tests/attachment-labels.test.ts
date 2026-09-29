/* R7.1d.3a — attachment corpus ↔ labels integrity. The labels are
 * reviewed judgments over the frozen corpus; this test pins coverage
 * (every claim labeled), identity (every label references a real corpus
 * claim) and the corpus hash so a silent corpus drift invalidates the
 * label set instead of quietly re-meaning it. */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const corpus = JSON.parse(
  readFileSync("tests/fixtures/attachment-corpus.json", "utf8"),
);
const labels = JSON.parse(
  readFileSync("tests/fixtures/attachment-labels.json", "utf8"),
);

test("labels cover every corpus claim exactly once", () => {
  const corpusClaims = new Set(
    corpus.events.flatMap((e: any) => e.claims.map((c: any) => c.claimId)),
  );
  const labeled = new Set<string>();
  for (const ev of labels.events) {
    for (const id of Object.keys(ev.claims)) {
      assert(corpusClaims.has(id), `label for non-corpus claim ${id}`);
      assert(!labeled.has(id), `duplicate label ${id}`);
      labeled.add(id);
    }
  }
  assert.equal(labeled.size, corpusClaims.size);
});

test("corpus hash pinned — label set invalidates on corpus drift", () => {
  assert.equal(labels.corpusHash, corpus.claimIdsHash);
});

test("label vocabulary is exactly the three claim classes", () => {
  const ok = new Set(["driver", "on_topic_non_driver", "misclustered"]);
  for (const ev of labels.events)
    for (const v of Object.values(ev.claims)) assert(ok.has(v as string));
});

test("every misclustered claim has a valid cause; causes are misclustered-only", () => {
  const ok = new Set(labels.causes as string[]);
  for (const ev of labels.events) {
    for (const [id, cause] of Object.entries(ev.causes as object)) {
      assert.equal(
        ev.claims[id],
        "misclustered",
        `cause on non-misclustered ${id}`,
      );
      assert(ok.has(cause), `unknown cause ${cause}`);
    }
    for (const [id, v] of Object.entries(ev.claims))
      if (v === "misclustered")
        assert(ev.causes[id], `misclustered ${id} missing cause`);
  }
});

test("extraction_gap events carry zero-driver claim sets", () => {
  for (const ev of labels.events) {
    if (!ev.extractionGap) continue;
    const drivers = Object.values(ev.claims).filter((v) => v === "driver");
    assert.equal(
      drivers.length,
      0,
      `gap event ${ev.eventId} cannot have a driver`,
    );
  }
});
