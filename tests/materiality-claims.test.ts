/* R7.1a/b — claim-level materiality acceptance tests.
 *
 * Invariants under test:
 *  - reasoning unit is the CLAIM (value + prev → economic action)
 *  - truth state caps transmission confidence, NEVER economic magnitude
 *  - retracted claims contribute nothing; unknown does not lift
 *  - event materiality = max credible claim, not an average
 *  - subject resolution degrades honestly (no fake entities)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateClaimsToEvent,
  approxUsd,
  inferClaimAction,
  resolveSubject,
  scoreClaimMateriality,
  type ClaimMaterialityInput,
} from "../lib/materiality-claims";
import { effectiveRoots } from "../lib/db/read";
import { standingClaimPos } from "../lib/db/adjudicate";
import {
  latestVotes,
  positionsFromVotes,
  posKey,
  rankWinner,
  type Vote,
} from "../lib/db/positions";

function claim(
  over: Partial<ClaimMaterialityInput> = {},
): ClaimMaterialityInput {
  return {
    claimId: "c1",
    predicate: "interest_rate",
    claimType: "policy",
    current: {
      versionId: "v2",
      value: 4.5,
      valueType: "number",
      unit: "%",
      qualifiers: { subject: "Federal Reserve" },
      state: "supported",
      validFrom: "2025-06-01",
    },
    previousVersion: {
      versionId: "v1",
      value: 4.5,
      unit: "%",
      state: "reported",
    },
    economicComparison: {
      from: 4.25,
      to: 4.5,
      unit: "%",
      basis: "explicit_in_claim",
      confidence: "high",
    },
    subject: { qualifierText: "Federal Reserve" },
    evidence: {
      claimState: "supported",
      confirmedIndependentOrigins: 3,
      primaryOrigins: 2,
      unresolvedOrigins: 0,
      derivedDocuments: 1,
      rawSourceCount: 4,
    },
    ...over,
  };
}

describe("economic action inference", () => {
  it("4.25 → 4.50 Fed funds = monetary_policy_change +0.25pp increase", () => {
    const a = inferClaimAction(claim());
    assert.equal(a.type, "monetary_policy_change");
    assert.equal(a.magnitude, 0.25);
    assert.equal(a.direction, "increase");
    assert.equal(a.affectedJurisdiction, "US"); // qualifierText resolved
  });

  it("rate level with no comparison = observation, not a step", () => {
    const r = scoreClaimMateriality(claim({ economicComparison: null }));
    assert.equal(r.action.type, "interest_rate_observation");
    assert.ok(r.reasonCodes.includes("rate_observation_only"));
    assert.equal(r.materiality, "limited");
  });

  it("previousVersion is truth history — a reported→supported bump is not a rate step", () => {
    /* prod reality: interest_rate 7% v1(reported) → v2(supported) is truth
     * convergence, not 6.75→7.00. previousVersion must never feed
     * the economic delta. */
    const r = scoreClaimMateriality(
      claim({
        economicComparison: null,
        previousVersion: {
          versionId: "v1",
          value: 4.25,
          unit: "%",
          state: "reported",
        },
      }),
    );
    assert.equal(r.action.type, "interest_rate_observation");
    assert.equal(r.materiality, "limited");
  });

  it("interest_rate without a policy authority → observation even with delta", () => {
    const r = scoreClaimMateriality(
      claim({ subject: { qualifierText: "Ngân hàng Vietcombank" } }),
    );
    assert.equal(r.action.type, "interest_rate_observation");
    assert.equal(r.materiality, "limited");
  });

  it("unmapped predicate → unknown_economic_action → abstain", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "hormuz_proposal",
        current: { ...claim().current, value: "đề xuất mở lại" },
      }),
    );
    assert.equal(r.action.type, "unknown_economic_action");
    assert.equal(r.materiality, "unknown");
  });

  it("deaths/match_score → non_economic → none", () => {
    for (const p of ["deaths", "match_score", "medal"]) {
      const r = scoreClaimMateriality(claim({ predicate: p }));
      assert.equal(r.action.type, "non_economic");
      assert.equal(r.materiality, "none");
    }
  });
});

describe("claim materiality vs truth state — independent dimensions", () => {
  it("disputed 100bp Fed hike: still systemic magnitude, capped transmission", () => {
    const r = scoreClaimMateriality(
      claim({
        current: { ...claim().current, value: 5.5, state: "disputed" },
        economicComparison: {
          from: 4.5,
          to: 5.5,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
        evidence: {
          claimState: "disputed",
          primaryOrigins: 0,
          confirmedIndependentOrigins: 1,
          unresolvedOrigins: 2,
          derivedDocuments: 0,
          rawSourceCount: 1,
        },
      }),
    );
    assert.equal(r.materiality, "systemic"); // magnitude not demoted
    assert.equal(r.transmissionConfidence, "low");
    assert.ok(r.cautions.includes("disputed"));
  });

  it("retracted → excluded, materiality none", () => {
    const r = scoreClaimMateriality(
      claim({
        current: { ...claim().current, state: "retracted" },
        evidence: {
          claimState: "retracted",
          primaryOrigins: 1,
          confirmedIndependentOrigins: 1,
          unresolvedOrigins: 0,
          derivedDocuments: 0,
          rawSourceCount: 1,
        },
      }),
    );
    assert.equal(r.materiality, "none");
    assert.equal(r.excluded, true);
  });

  it("corrected claim is assessed on the corrected value", () => {
    const r = scoreClaimMateriality(
      claim({
        current: { ...claim().current, value: 5.5, state: "corrected" },
        economicComparison: {
          from: 4.5,
          to: 5.5,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
        evidence: {
          claimState: "corrected",
          primaryOrigins: 1,
          confirmedIndependentOrigins: 2,
          unresolvedOrigins: 0,
          derivedDocuments: 0,
          rawSourceCount: 1,
        },
      }),
    );
    assert.equal(r.materiality, "systemic");
    assert.ok(r.cautions.includes("corrected_claim"));
  });

  it("reported → capped at medium confidence, still contributes", () => {
    const r = scoreClaimMateriality(
      claim({
        current: { ...claim().current, state: "reported" },
        evidence: {
          claimState: "reported",
          primaryOrigins: 0,
          confirmedIndependentOrigins: 1,
          unresolvedOrigins: 0,
          derivedDocuments: 0,
          rawSourceCount: 1,
        },
      }),
    );
    assert.equal(r.transmissionConfidence, "medium");
    assert.ok(r.cautions.includes("single_report"));
  });
});

describe("magnitude thresholds", () => {
  it("ECBDFR-style +0.75pp global CB step → major", () => {
    const r = scoreClaimMateriality(
      claim({
        current: { ...claim().current, value: 1.5 },
        economicComparison: {
          from: 0.75,
          to: 1.5,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
        subject: { qualifierText: "ECB" },
      }),
    );
    assert.equal(r.materiality, "major");
    assert.ok(r.reasonCodes.includes("policy_step_large"));
  });

  it("tariff 20→10 reduction on US lane → major via tariff_change", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "tariff_rate",
        current: {
          ...claim().current,
          value: 10,
          unit: "%",
          qualifiers: { subject: "Mỹ" },
        },
        economicComparison: {
          from: 30,
          to: 10,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
        subject: { qualifierText: "Mỹ" },
      }),
    );
    assert.equal(r.action.type, "tariff_change");
    assert.equal(r.action.direction, "decrease");
    assert.equal(r.materiality, "major");
    assert.deepEqual(r.channels.sort(), ["external", "policy_regulatory"]);
  });

  it("tariff value '30 tỷ USD' is a $ amount, not a 30pp rate — never systemic", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "tariff_reduction",
        current: {
          ...claim().current,
          value: "30 tỷ USD",
          unit: "USD",
          valueType: "text",
        },
        economicComparison: null,
        subject: { qualifierText: "Trung Quốc và Mỹ" },
      }),
    );
    assert.equal(r.action.type, "tariff_change");
    assert.notEqual(r.materiality, "systemic"); // USD flow ≠ pp ladder
    assert.ok(r.reasonCodes.includes("tariff_flow_large"));
  });

  it("'6,6 tỉ euro' disbursement parses ≈ $7.1B → meaningful", () => {
    const usd = approxUsd("6,6 tỉ euro", "euro");
    assert.ok(usd !== null && usd > 6e9 && usd < 8e9);
    const r = scoreClaimMateriality(
      claim({
        predicate: "fund_disbursement",
        current: {
          ...claim().current,
          value: "6,6 tỉ euro",
          unit: "euro",
          valueType: "text",
        },
        economicComparison: null,
        subject: { qualifierText: "EU" },
      }),
    );
    assert.equal(r.materiality, "meaningful");
  });

  it("'2.300 tỷ đồng' profit — VN thousands-dot parse, not 2.3", () => {
    const usd = approxUsd("2.300 tỷ đồng", "VNĐ");
    assert.ok(usd !== null && usd > 8e7); // ~$92M, not $92
  });
});

describe("subject resolution — honest degradation", () => {
  it("entityId present → resolved, no caution", () => {
    const s = resolveSubject(
      claim({
        subject: {
          entityId: "e1",
          canonicalKey: "org:federal_reserve",
          type: "institution",
          countryCode: "US",
        },
      }),
    );
    assert.equal(s.jurisdiction, "US");
    assert.equal(s.caution, null);
  });

  it("qualifierText only → jurisdiction hint + subject_text_only caution", () => {
    const s = resolveSubject(claim({ subject: { qualifierText: "NHNN" } }));
    assert.equal(s.jurisdiction, "VN");
    assert.equal(s.entityId, null);
    assert.equal(s.caution, "subject_text_only");
  });

  it("no subject at all → subject_unresolved, no fake entity", () => {
    const s = resolveSubject(claim({ subject: {} }));
    assert.equal(s.jurisdiction, null);
    assert.equal(s.caution, "subject_unresolved");
  });
});

describe("event aggregation — max credible claim, not average", () => {
  it("1 major + trivia claims → event is major, driver recorded", () => {
    const trivia = ["deaths", "match_score", "speech_location"].map((p, i) =>
      scoreClaimMateriality(claim({ claimId: `t${i}`, predicate: p })),
    );
    const big = scoreClaimMateriality(
      claim({
        claimId: "big",
        current: { ...claim().current, value: 5.5 },
        economicComparison: {
          from: 4.5,
          to: 5.5,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
      }),
    );
    const agg = aggregateClaimsToEvent([...trivia, big]);
    assert.equal(agg.materiality, "systemic");
    assert.deepEqual(agg.driverClaimIds, ["big"]);
    assert.ok(agg.channels.includes("discounting"));
  });

  it("retracted + unknown never lift the event", () => {
    const claims = [
      scoreClaimMateriality(
        claim({
          claimId: "r",
          current: { ...claim().current, state: "retracted" },
          evidence: {
            claimState: "retracted",
            primaryOrigins: 0,
            confirmedIndependentOrigins: 0,
            unresolvedOrigins: 0,
            derivedDocuments: 0,
            rawSourceCount: 1,
          },
        }),
      ),
      scoreClaimMateriality(
        claim({ claimId: "u", predicate: "mystery_thing" }),
      ),
    ];
    const agg = aggregateClaimsToEvent(claims);
    assert.equal(agg.materiality, "unknown"); // unknown present, nothing live
    assert.equal(agg.driverClaimIds.length, 0);
  });

  it("all-retracted event → none", () => {
    const agg = aggregateClaimsToEvent([
      scoreClaimMateriality(
        claim({
          current: { ...claim().current, state: "retracted" },
          evidence: {
            claimState: "retracted",
            primaryOrigins: 0,
            confirmedIndependentOrigins: 0,
            unresolvedOrigins: 0,
            derivedDocuments: 0,
            rawSourceCount: 1,
          },
        }),
      ),
    ]);
    assert.equal(agg.materiality, "none");
  });

  it("limited-only claims aggregate to limited, not 'no news'", () => {
    const agg = aggregateClaimsToEvent([
      scoreClaimMateriality(claim({ predicate: "debt_to_gdp" })),
      scoreClaimMateriality(claim({ predicate: "dividend" })),
    ]);
    assert.equal(agg.materiality, "limited");
    // sub-meaningful event explains itself through its own drivers
    assert.equal(agg.contributingClaimIds.length, 2);
  });

  it("event scope = broadest driver scope, independent of input order", () => {
    const a = scoreClaimMateriality(
      claim({
        claimId: "issuer-claim",
        predicate: "fund_disbursement",
        current: { ...claim().current, value: 8_000_000_000, unit: "usd" },
        subject: {
          qualifierText: "Vinamilk",

          entityId: null,
          type: "company",
        },
      }),
    );
    const b = scoreClaimMateriality(
      claim({
        claimId: "global-claim",
        predicate: "fund_disbursement",
        current: { ...claim().current, value: 8_000_000_000, unit: "usd" },
        subject: { qualifierText: "Federal Reserve", entityId: null },
      }),
    );
    assert.equal(a.materiality, b.materiality); // both must be drivers
    assert.equal(a.scope, "issuer");
    assert.equal(b.scope, "global_systemic");
    const fwd = aggregateClaimsToEvent([a, b]);
    const rev = aggregateClaimsToEvent([b, a]);
    assert.deepEqual(rev, fwd, "reversed input → identical output");
    assert.equal(fwd.scope, "global_systemic"); // broadest wins, not [0]
    assert.deepEqual(
      fwd.driverClaimIds.sort(),
      ["global-claim", "issuer-claim"].sort(),
    );
  });

  it("shuffle-invariance: same claim set → byte-identical aggregation", () => {
    const mk = (id: string, pred: string, v: number) =>
      scoreClaimMateriality(
        claim({
          claimId: id,
          predicate: pred,
          current: { ...claim().current, value: v, unit: "usd" },
        }),
      );
    const claims = [
      mk("c1", "fund_disbursement", 6e9),
      mk("c2", "fund_disbursement", 7e9),
      mk("c3", "dividend", 100),
      mk("c4", "debt_to_gdp", 40),
      mk("c5", "net_profit", 5e6),
    ];
    const base = JSON.stringify(aggregateClaimsToEvent(claims));
    for (let i = 0; i < 25; i++) {
      // deterministic shuffle via rotation + reversal
      const sh = [...claims.slice(i % 5), ...claims.slice(0, i % 5)];
      if (i % 2) sh.reverse();
      assert.equal(JSON.stringify(aggregateClaimsToEvent(sh)), base);
    }
  });

  it("coverage audits unknowns without changing the materiality call", () => {
    const claims = [
      scoreClaimMateriality(
        claim({
          claimId: "m",
          predicate: "fund_disbursement",
          current: { ...claim().current, value: 6e9, unit: "usd" },
        }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        scoreClaimMateriality(
          claim({ claimId: `u${i}`, predicate: "mystery" }),
        ),
      ),
    ];
    const agg = aggregateClaimsToEvent(claims);
    assert.equal(agg.materiality, "meaningful"); // 30 unknowns don't drag it
    assert.equal(agg.coverage.totalClaims, 31);
    assert.equal(agg.coverage.unknownClaims, 30);
    assert.equal(agg.coverage.materialClaims, 1);
    assert.equal(agg.coverage.classifiedClaims, 1);
  });
});

/* ── R7.1b — provenance reuses canonical effectiveRoots semantics ── */

type Doc = { doc_id: string; source_id: string; kind: string };
const doc = (id: string, source: string, kind = "news"): Doc => ({
  doc_id: id,
  source_id: source,
  kind,
});

describe("claim evidence stats — canonical effectiveRoots semantics", () => {
  it("Reuters original + 4 syndicated Reuters copies → 1 independent origin", () => {
    const docs = [
      doc("d0", "reuters"),
      doc("d1", "reuters"),
      doc("d2", "reuters"),
      doc("d3", "reuters"),
      doc("d4", "reuters"),
    ];
    const lin = new Map<string, { parent: string | null; relation: string }>([
      ["d0", { parent: null, relation: "original" }],
      ["d1", { parent: "d0", relation: "syndicated" }],
      ["d2", { parent: "d0", relation: "syndicated" }],
      ["d3", { parent: "d0", relation: "syndicated" }],
      ["d4", { parent: "d0", relation: "syndicated" }],
    ]);
    const s = effectiveRoots(docs, lin);
    assert.equal(s.confirmedIndependentOrigins, 1); // one newsroom, not five docs
    assert.equal(s.derivedDocuments, 4);
    assert.equal(s.unresolvedOrigins, 0);
  });

  it("Fed primary doc + 10 rewrites → 1 primary origin", () => {
    const docs = [doc("f0", "federalreserve.gov", "primary")];
    const lin = new Map<string, { parent: string | null; relation: string }>([
      ["f0", { parent: null, relation: "original" }],
    ]);
    for (let i = 1; i <= 10; i++) {
      docs.push(doc(`r${i}`, `outlet${i}`));
      lin.set(`r${i}`, { parent: "f0", relation: "rewritten" });
    }
    const s = effectiveRoots(docs, lin);
    assert.equal(s.primaryOrigins, 1); // source.kind='primary' ≠ relation='original'
    assert.equal(s.confirmedIndependentOrigins, 1);
    assert.equal(s.derivedDocuments, 10);
    assert.equal(s.unresolvedOrigins, 0);
  });

  it("unknown / no-lineage document → 1 unresolved origin", () => {
    const s1 = effectiveRoots([doc("u1", "mystery")], new Map());
    assert.equal(s1.unresolvedOrigins, 1);
    const s2 = effectiveRoots(
      [doc("u2", "mystery")],
      new Map([["u2", { parent: null, relation: "unknown" }]]),
    );
    assert.equal(s2.unresolvedOrigins, 1);
    assert.equal(s2.confirmedIndependentOrigins, 0);
  });

  it("dangling derived chain → unresolved, never silently resolved", () => {
    const s = effectiveRoots(
      [doc("c1", "blog")],
      new Map([["c1", { parent: "ghost", relation: "rewritten" }]]),
    );
    assert.equal(s.unresolvedOrigins, 1);
    assert.equal(s.confirmedIndependentOrigins, 0);
  });
});

/* ── R7.1b.2 — standing-position parity with R6 truth ── */

const vote = (
  voter: string,
  value: number,
  over: Partial<Vote> = {},
): Vote => ({
  voter,
  pos: posKey(value, "%"),
  valueJson: JSON.stringify(value),
  unit: "%",
  versionNo: 1,
  state: "supported",
  primary: false,
  at: 1000,
  ...over,
});
const vers = (values: number[]) =>
  values.map((v, i) => ({
    id: `v${i + 1}`,
    version_no: i + 1,
    pos: posKey(v, "%"),
    valueJson: JSON.stringify(v),
  }));

describe("standingClaimPos — R6/R7 parity", () => {
  it("primary beats publisher majority — R7 standing == R6 winner", () => {
    // A: Reuters+BBC publishers stand on 20; B: one Fed DIRECT primary on 25
    const votes = [
      vote("reuters", 20, { at: 2000 }),
      vote("bbc", 20, { at: 2000 }),
      vote("fed", 25, { at: 1000, primary: true }),
    ];
    const positions = [
      ...positionsFromVotes(latestVotes(votes), vers([20, 25])).values(),
    ];
    const r6Winner = rankWinner(positions)!.pos;
    const r7Standing = standingClaimPos({
      positions,
      currentPos: posKey(25, "%"),
      currentState: "disputed",
    });
    assert.equal(r6Winner, posKey(25, "%")); // primary wins, not majority
    assert.equal(r7Standing, r6Winner);
  });

  it("corrected current value beats the old majority position", () => {
    // 10 publishers said 100; authority correction stands on 80
    const votes = Array.from({ length: 10 }, (_, i) =>
      vote(`outlet${i}`, 100, { at: 1000 }),
    );
    const positions = [
      ...positionsFromVotes(latestVotes(votes), vers([100, 80])).values(),
    ];
    const standing = standingClaimPos({
      positions,
      currentPos: posKey(80, "%"),
      currentState: "corrected",
    });
    // R6 keeps corrected truth; provenance must follow the corrected
    // position — never re-adjudicate back to the outvoted 100
    assert.equal(standing, posKey(80, "%"));
    assert.equal(rankWinner(positions)!.pos, posKey(100, "%")); // what a raw
    // rankWinner would wrongly pick — the protected guard is load-bearing
  });

  it("confirmed position: later publisher disagreement cannot re-root", () => {
    const votes = [
      vote("fed", 25, { at: 1000, primary: true }),
      vote("reuters", 30, { at: 3000 }), // later disagreement
      vote("bbc", 30, { at: 3000 }),
    ];
    const positions = [
      ...positionsFromVotes(latestVotes(votes), vers([25, 30])).values(),
    ];
    const standing = standingClaimPos({
      positions,
      currentPos: posKey(25, "%"),
      currentState: "confirmed",
    });
    assert.equal(standing, posKey(25, "%")); // protected
  });

  it("mutable disputed/supported still follows canonical rankWinner", () => {
    const votes = [
      vote("reuters", 20),
      vote("bbc", 20),
      vote("vne", 35, { at: 2000 }),
    ];
    const positions = [
      ...positionsFromVotes(latestVotes(votes), vers([20, 35])).values(),
    ];
    for (const st of ["reported", "supported", "disputed"]) {
      const standing = standingClaimPos({
        positions,
        currentPos: posKey(35, "%"), // current version could be either
        currentState: st,
      });
      assert.equal(standing, rankWinner(positions)!.pos); // majority pos 20
    }
  });

  it("invariant: same fixture → R6 rankWinner == R7 standing for mutable states", () => {
    // parity test: any mutable claim must land on exactly what R6's
    // canonical ranking produces, byte-identical pos
    const votes = [
      vote("a", 1),
      vote("b", 1),
      vote("c", 2, { at: 3000, primary: true }),
    ];
    const positions = [
      ...positionsFromVotes(latestVotes(votes), vers([1, 2])).values(),
    ];
    assert.equal(
      standingClaimPos({
        positions,
        currentPos: posKey(1, "%"),
        currentState: "supported",
      }),
      rankWinner(positions)!.pos,
    );
  });
});

/* ── R7.1b — subject resolution hardening ── */

describe("R7.1b subject semantics", () => {
  it("unicode boundary: 'Bộ Tài Chính Mỹ' / bare 'Mỹ' resolve to US", () => {
    for (const t of ["Bộ Tài Chính Mỹ", "Mỹ", "Nhà Trắng"]) {
      const s = resolveSubject(claim({ subject: { qualifierText: t } }));
      assert.equal(s.jurisdiction, "US", t);
    }
  });

  it("'Mỹ và Trung Quốc' yields BOTH jurisdictions, not just the first", () => {
    const s = resolveSubject(
      claim({ subject: { qualifierText: "Mỹ và Trung Quốc" } }),
    );
    assert.deepEqual([...s.jurisdictions].sort(), ["CN", "US"]);
  });

  it("canonicalKey fallback when qualifierText is null", () => {
    const s = resolveSubject(
      claim({
        subject: { qualifierText: null, canonicalKey: "Bộ Tài Chính Mỹ" },
      }),
    );
    assert.equal(s.jurisdiction, "US");
  });

  it("text-resolved company keeps declared type → issuer scope", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "net_profit",
        current: {
          ...claim().current,
          value: "9.500 tỷ đồng",
          valueType: "text",
          unit: "VNĐ",
        },
        economicComparison: {
          from: 7.2e9,
          to: 9.5e9,
          unit: "USD",
          basis: "prior_reporting_period",
          confidence: "high",
        },
        subject: { qualifierText: "Vinamilk", type: "company" },
      }),
    );
    assert.equal(r.scope, "issuer");
    assert.equal(r.materiality, "meaningful"); // earnings_delta, not unscoped
  });
});

describe("R7.1b scoring guards", () => {
  it("NHNN +25bp home-market policy step → meaningful, not limited", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "refinancing_rate",
        current: { ...claim().current, value: 4.75 },
        economicComparison: {
          from: 4.5,
          to: 4.75,
          unit: "%",
          basis: "explicit_in_claim",
          confidence: "high",
        },
        subject: { qualifierText: "NHNN" },
      }),
    );
    assert.equal(r.action.type, "monetary_policy_change");
    assert.equal(r.materiality, "meaningful");
    assert.equal(r.scope, "vietnam");
  });

  it("narrow sanctions (individuals / restricted services) stay limited", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "sanctions",
        current: {
          ...claim().current,
          value: "trừng phạt 3 cá nhân quan chức",
          valueType: "text",
          unit: null,
        },
        economicComparison: null,
        subject: { qualifierText: "Mỹ" },
      }),
    );
    assert.equal(r.materiality, "limited");
    assert.ok(r.reasonCodes.includes("sanction_narrow"));
  });

  it("non-percent indicator magnitude never takes the % ladder", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "commodity_purchase",
        current: {
          ...claim().current,
          value: "20 triệu tấn than Mỹ trong 2 năm",
          valueType: "text",
          unit: "tấn",
        },
        economicComparison: null,
        subject: { qualifierText: "Trung Quốc" },
      }),
    );
    assert.equal(r.materiality, "limited"); // 20M tons ≠ 20pp
  });

  it("≥$5B disbursement is meaningful even with unresolved subject", () => {
    const r = scoreClaimMateriality(
      claim({
        predicate: "fund_disbursement",
        current: {
          ...claim().current,
          value: "6,6 tỉ euro",
          valueType: "text",
          unit: "euro",
        },
        economicComparison: null,
        subject: {},
      }),
    );
    assert.equal(r.materiality, "meaningful");
  });

  it("credit_freeze on a global jurisdiction → systemic; VN → local major-capable", () => {
    const us = scoreClaimMateriality(
      claim({
        predicate: "credit_freeze",
        current: {
          ...claim().current,
          value: "thị trường liên ngân hàng đóng băng",
          valueType: "text",
          unit: null,
        },
        economicComparison: null,
        subject: { qualifierText: "Mỹ" },
      }),
    );
    assert.equal(us.action.type, "credit_liquidity_shock");
    assert.equal(us.materiality, "systemic");
  });
});
