/* R7.1d.3a.1 — attachment corpus ↔ labels integrity. The labels are
 * reviewed judgments over the frozen corpus; this test pins coverage
 * (every claim labeled), identity (every label references a real corpus
 * claim), the semantic corpusHash (a provenance drift invalidates the
 * label set), the cause-proxy vocabulary, and the extraction-gap
 * invariant (≥1 reviewed on-story doc AND zero surviving on-story
 * claims — a fully-foreign event is NOT a gap). */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentCorpusHash } from "../scripts/materiality/attachment-hash";

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
  assert.equal(labels.corpusHash, corpus.corpusHash);
  // the pinned hash is the SHARED canonicalizer's output, not a literal
  assert.equal(corpus.corpusHash, attachmentCorpusHash(corpus.events));
});

test("label vocabulary is exactly the three claim classes", () => {
  const ok = new Set(["driver", "on_topic_non_driver", "misclustered"]);
  for (const ev of labels.events)
    for (const v of Object.values(ev.claims)) assert(ok.has(v as string));
});

test("every misclustered claim carries a valid causeProxy + confidence; proxies are misclustered-only", () => {
  const okProxy = new Set(labels.causeProxies as string[]);
  const okConf = new Set(labels.causeConfidences as string[]);
  for (const ev of labels.events) {
    for (const [id, proxy] of Object.entries(ev.causeProxies as object)) {
      assert.equal(
        ev.claims[id],
        "misclustered",
        `causeProxy on non-misclustered ${id}`,
      );
      assert(okProxy.has(proxy), `unknown causeProxy ${proxy}`);
      assert(
        okConf.has(ev.causeConfidence[id]),
        `missing/invalid confidence for ${id}`,
      );
    }
    for (const [id, v] of Object.entries(ev.claims))
      if (v === "misclustered")
        assert(ev.causeProxies[id], `misclustered ${id} missing causeProxy`);
  }
});

test("extraction_gap ⇒ ≥1 reviewed on-story doc AND zero on-story claims", () => {
  for (const ev of labels.events) {
    const corpusEv = corpus.events.find((e: any) => e.eventId === ev.eventId);
    assert(corpusEv, `labels reference missing event ${ev.eventId}`);
    const onStoryIds = new Set(
      (ev.onStoryEventEvidence as any[]).map((d) => d.documentId),
    );
    if (ev.extractionGap) {
      // 1. at least one reviewed on-story doc, verified live (attached,
      //    non-detached) in the corpus eventEvidence snapshot
      assert(onStoryIds.size > 0, `gap ${ev.eventId} has no on-story doc`);
      const liveIds = new Set(
        corpusEv.eventEvidence
          .filter((d: any) => !d.detached)
          .map((d: any) => d.documentId),
      );
      for (const id of onStoryIds)
        assert(
          liveIds.has(id),
          `gap ${ev.eventId} on-story doc ${id} not live`,
        );
      // 2. zero surviving on-story claims
      assert(
        Object.values(ev.claims).every((v) => v === "misclustered"),
        `gap ${ev.eventId} has a surviving on-story claim`,
      );
    }
    // converse enforcement: an all-misclustered event without a gap flag
    // must be fullyForeign — never silently both/neither
    const allMis =
      Object.keys(ev.claims).length > 0 &&
      Object.values(ev.claims).every((v) => v === "misclustered");
    assert.equal(
      allMis && !ev.extractionGap,
      Boolean(ev.fullyForeign),
      `${ev.eventId}: all-mis/non-gap must equal fullyForeign`,
    );
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

/* ── corpusHash semantics ── */

const baseEvent = (): {
  eventId: string;
  eventVersionId: string | null;
  title: string | null;
  mergePaths: Record<string, number>;
  eventEvidence: {
    documentId: string;
    evidenceVersionId: string;
    detached: boolean;
    activeEvents: string[];
  }[];
  claims: {
    claimId: string;
    currentClaimVersionId: string | null;
    materialityAssessmentId: string | null;
    standingEvidence: {
      documentId: string;
      evidenceVersionId: string;
      activeEvents: string[];
    }[];
  }[];
} => ({
  eventId: "e1",
  eventVersionId: "ev1",
  title: "t",
  mergePaths: { headline: 2, semantic_xlang: 1 },
  eventEvidence: [
    {
      documentId: "d1",
      evidenceVersionId: "evd1",
      detached: false,
      activeEvents: ["e1", "e9"],
    },
  ],
  claims: [
    {
      claimId: "c1",
      currentClaimVersionId: "cv1",
      materialityAssessmentId: "a1",
      standingEvidence: [
        {
          documentId: "d1",
          evidenceVersionId: "evd1",
          activeEvents: ["e1", "e9"],
        },
      ],
    },
  ],
});

test("corpusHash changes when doc fanout changes", () => {
  const a = [baseEvent()];
  const b = [baseEvent()];
  b[0].claims[0].standingEvidence[0].activeEvents = ["e1"];
  assert.notEqual(attachmentCorpusHash(a), attachmentCorpusHash(b));
});

test("corpusHash changes when resolver merge paths change", () => {
  const a = [baseEvent()];
  const b = [baseEvent()];
  b[0].mergePaths = { headline: 2 }; // dropped semantic_xlang
  assert.notEqual(attachmentCorpusHash(a), attachmentCorpusHash(b));
});

test("corpusHash is shuffle-stable across evidence ordering", () => {
  const a = [baseEvent(), { ...baseEvent(), eventId: "e2" }];
  const b = structuredClone(a).reverse();
  // also shuffle inner arrays
  b[0].claims[0].standingEvidence.push({
    documentId: "d0",
    evidenceVersionId: "evd0",
    activeEvents: ["e1"],
  });
  b[0].claims[0].standingEvidence.reverse();
  const c = structuredClone(b);
  c[0].claims[0].standingEvidence.reverse();
  assert.equal(attachmentCorpusHash(b), attachmentCorpusHash(c));
  assert.notEqual(attachmentCorpusHash(a), attachmentCorpusHash(b));
});
