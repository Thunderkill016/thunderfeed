import { writeFileSync } from "node:fs";
import type { ClaimMaterialityAssessment } from "../../lib/materiality-claims.ts";

/* R7.1d synthetic challenge cases — pure ClaimMaterialityAssessment fixtures
 * exercising the aggregator's invariants. */
let n = 0;
const mk = (
  over: Partial<ClaimMaterialityAssessment> &
    Pick<ClaimMaterialityAssessment, "materiality">,
): ClaimMaterialityAssessment => ({
  claimId: `syn-${(++n).toString(36).padStart(4, "0")}`,
  claimVersionId: `svenv-${n}`,
  materiality: over.materiality,
  scope:
    over.scope ??
    (["none", "unknown"].includes(over.materiality) ? null : "vietnam"),
  channels:
    over.channels ??
    (over.materiality === "none" || over.materiality === "unknown"
      ? []
      : ["fundamental"]),
  affectedTargets: over.affectedTargets ?? [],
  directness: over.directness ?? null,
  persistence: over.persistence ?? null,
  horizon: over.horizon ?? null,
  transmissionConfidence:
    over.transmissionConfidence ??
    (over.materiality === "none" || over.materiality === "unknown"
      ? null
      : "medium"),
  reason: over.reason ?? `synthetic ${over.materiality}`,
  reasonCodes: over.reasonCodes ?? [],
  cautions: over.cautions ?? [],
  excluded: over.excluded ?? false,
  evidenceState: over.evidenceState ?? "reported",
  action: over.action ?? {
    type: "unknown_economic_action",
    actor: null,
    affectedJurisdiction: null,
    magnitude: null,
    magnitudeUnit: null,
    direction: null,
    confidence: "low",
    sourceClaimVersionId: `svenv-${n}`,
  },
  method: "deterministic-claim",
  methodVersion: "r7.1b.1",
});
const seq = (
  mat: ClaimMaterialityAssessment["materiality"],
  count: number,
  over: Partial<ClaimMaterialityAssessment> = {},
) => Array.from({ length: count }, () => mk({ ...over, materiality: mat }));

const cases: {
  id: string;
  note: string;
  claims: ClaimMaterialityAssessment[];
  expect: Record<string, unknown>;
}[] = [
  {
    id: "unknown60+major1",
    note: "60 unknown + 1 major → major",
    claims: [
      ...seq("unknown", 60),
      mk({ materiality: "major", scope: "global_systemic" }),
    ],
    expect: { materiality: "major", scope: "global_systemic" },
  },
  {
    id: "none100+systemic1",
    note: "100 none + 1 systemic → systemic",
    claims: [
      ...seq("none", 100),
      mk({ materiality: "systemic", scope: "global_systemic" }),
    ],
    expect: { materiality: "systemic", scope: "global_systemic" },
  },
  {
    id: "retractedSystemic+limited",
    note: "excluded systemic + limited live → limited",
    claims: [
      mk({
        materiality: "systemic",
        scope: "global_systemic",
        excluded: true,
        evidenceState: "retracted",
      }),
      mk({ materiality: "limited", scope: "sector" }),
    ],
    expect: { materiality: "limited", scope: "sector" },
  },
  {
    id: "disputedSystemic",
    note: "disputed systemic → systemic w/ caution",
    claims: [
      mk({
        materiality: "systemic",
        scope: "global_systemic",
        evidenceState: "disputed",
        cautions: ["disputed_evidence"],
      }),
    ],
    expect: {
      materiality: "systemic",
      scope: "global_systemic",
      cautions: ["disputed_evidence"],
    },
  },
  {
    id: "twoMajorDiffScope",
    note: "two major drivers issuer+global → global_systemic",
    claims: [
      mk({ materiality: "major", scope: "issuer" }),
      mk({ materiality: "major", scope: "global_systemic" }),
    ],
    expect: { materiality: "major", scope: "global_systemic" },
  },
  {
    id: "twoMajorDiffScopeRev",
    note: "same reversed → identical",
    claims: [
      mk({ materiality: "major", scope: "global_systemic" }),
      mk({ materiality: "major", scope: "issuer" }),
    ],
    expect: { materiality: "major", scope: "global_systemic" },
  },
  {
    id: "allUnknown",
    note: "all unknown → unknown",
    claims: seq("unknown", 40),
    expect: { materiality: "unknown" },
  },
  {
    id: "allNone",
    note: "all none → none",
    claims: seq("none", 40),
    expect: { materiality: "none" },
  },
  {
    id: "allExcluded",
    note: "all excluded → none",
    claims: seq("meaningful", 20, { excluded: true }),
    expect: { materiality: "none" },
  },
  {
    id: "meaningful1+unknown100",
    note: "1 meaningful + 100 unknown → meaningful",
    claims: [
      mk({ materiality: "meaningful", scope: "vietnam" }),
      ...seq("unknown", 100),
    ],
    expect: { materiality: "meaningful", scope: "vietnam" },
  },
  {
    id: "unknownNoneNeverDrivers",
    note: "unknown/none never in driverClaimIds",
    claims: [
      ...seq("unknown", 30),
      ...seq("none", 30),
      mk({ materiality: "limited" }),
    ],
    expect: { materiality: "limited", noDriverLevels: ["unknown", "none"] },
  },
  {
    id: "empty",
    note: "empty event → none, empty arrays",
    claims: [],
    expect: { materiality: "none" },
  },
  {
    id: "meaningfulAndMajor",
    note: "meaningful+major → major, drivers=majors only",
    claims: [
      mk({ materiality: "major", scope: "vietnam" }),
      ...seq("meaningful", 3),
    ],
    expect: {
      materiality: "major",
      scope: "vietnam",
      allDriversLevel: "major",
    },
  },
  {
    id: "limitedOnlyMulti",
    note: "limited-only → drivers=contributors",
    claims: seq("limited", 3),
    expect: { materiality: "limited", driversEqContributors: true },
  },
  {
    id: "sectorVsVietnam",
    note: "same level sector+vietnam → vietnam",
    claims: [
      mk({ materiality: "limited", scope: "sector" }),
      mk({ materiality: "limited", scope: "vietnam" }),
    ],
    expect: { materiality: "limited", scope: "vietnam" },
  },
  {
    id: "issuerVsSector",
    note: "issuer+sector → sector",
    claims: [
      mk({ materiality: "meaningful", scope: "issuer" }),
      mk({ materiality: "meaningful", scope: "sector" }),
    ],
    expect: { materiality: "meaningful", scope: "sector" },
  },
  {
    id: "excludedDominates",
    note: "200 excluded major + 1 live none → none",
    claims: [
      ...seq("major", 200, { excluded: true }),
      mk({ materiality: "none" }),
    ],
    expect: { materiality: "none" },
  },
  {
    id: "unknownDoesNotDowngrade",
    note: "systemic + 80 unknown → systemic",
    claims: [
      mk({ materiality: "systemic", scope: "global_systemic" }),
      ...seq("unknown", 80),
    ],
    expect: { materiality: "systemic", scope: "global_systemic" },
  },
  {
    id: "singleLiveNone",
    note: "single none → none",
    claims: [mk({ materiality: "none" })],
    expect: { materiality: "none" },
  },
  {
    id: "channelsUnion",
    note: "channels = sorted union across contributors",
    claims: [
      mk({ materiality: "major", scope: "vietnam", channels: ["discounting"] }),
      mk({
        materiality: "major",
        scope: "vietnam",
        channels: ["funding_liquidity"],
      }),
    ],
    expect: {
      materiality: "major",
      scope: "vietnam",
      channels: ["discounting", "funding_liquidity"],
    },
  },
  {
    id: "targetsUnion",
    note: "targets = deduped union across contributors",
    claims: [
      mk({
        materiality: "meaningful",
        scope: "vietnam",
        affectedTargets: [{ type: "country_exposure", key: "vn" }],
      }),
      mk({
        materiality: "meaningful",
        scope: "vietnam",
        affectedTargets: [
          { type: "country_exposure", key: "vn" },
          { type: "instrument", key: "vnd" },
        ],
      }),
    ],
    expect: {
      materiality: "meaningful",
      targets: [
        { type: "country_exposure", key: "vn" },
        { type: "instrument", key: "vnd" },
      ],
    },
  },
  {
    id: "cautionPropagate",
    note: "driver cautions union into event",
    claims: [
      mk({
        materiality: "meaningful",
        scope: "vietnam",
        cautions: ["thin_evidence"],
      }),
    ],
    expect: { materiality: "meaningful", cautions: ["thin_evidence"] },
  },
  {
    id: "lowConfidenceAll",
    note: "all drivers low → confidence low",
    claims: seq("meaningful", 3, { transmissionConfidence: "low" }),
    expect: { materiality: "meaningful", confidence: "low" },
  },
  {
    id: "mixedConfidence",
    note: "mixed driver confidence → min",
    claims: [
      mk({
        materiality: "meaningful",
        scope: "vietnam",
        transmissionConfidence: "high",
      }),
      mk({
        materiality: "meaningful",
        scope: "vietnam",
        transmissionConfidence: "low",
      }),
    ],
    expect: { materiality: "meaningful", confidence: "low" },
  },
  {
    id: "noneAndUnknown",
    note: "none+unknown → unknown (uncertainty beats proven-nothing)",
    claims: [...seq("none", 10), ...seq("unknown", 10)],
    expect: { materiality: "unknown" },
  },
];
writeFileSync(
  "tests/fixtures/materiality-events-synthetic.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      methodVersion: "r7.1d",
      cases,
    },
    null,
    2,
  ),
);
console.log(`synthetic cases=${cases.length} claims=${n}`);
