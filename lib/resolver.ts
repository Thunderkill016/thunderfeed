/**
 * Pure event-resolution layer — the merge/split decision as a testable
 * function over explicit features. No DB, no IO: the DB layer (writer.ts)
 * loads candidate state, builds features, calls decide(), and persists
 * the result. The benchmark replays the same code path.
 *
 * V2 design:
 *   Stage A — candidate retrieval happens in writer.ts (SQL: live events
 *             inside a domain-aware window; JS recall filter: shared
 *             entity / claim / lexical / semantic signal).
 *   Stage B — decide() scores ONE (incoming, candidate) pair and returns
 *             merge | split | ambiguous with reasons + hardBlocks.
 *
 * A score is never "cosine > X ⇒ same event": semantic similarity is ONE
 * feature beside lexical overlap, entity anchors, claim identity,
 * numeric agreement and hard contradiction blocks.
 */

import { entitySignature } from "./entities";
import { canonValue } from "./format";
import { normalizeText } from "./model";
import { cosine } from "./embed";
import type { ExtractedClaim } from "./db/writer";
import type { StoryCluster } from "./model";

/* ------------------------------ taxonomy ---------------------------------- */

export type ResolverOutcome = "merge" | "split" | "ambiguous";

export interface ResolverDecision {
  decision: ResolverOutcome;
  /** best firing path — which rule produced the merge/split */
  path: string;
  /** max feature score across merge paths */
  score: number;
  /** human-auditable evidence lines */
  reasons: string[];
  /** contradiction signals that vetoed merge paths */
  hardBlocks: string[];
  /** the computed pair features — full audit payload */
  features?: PairFeatures;
}

/** normalized incoming-cluster side of a pair */
export interface IncomingSide {
  signature: string;
  sigTokens: Set<string>;
  numTokens: Set<string>;
  bigTokens: Set<string>;
  entTokens: Set<string>;
  entCoreTokens: Set<string>;
  distinctiveKeys: Set<string>;
  genericFps: Set<string>;
  topic: string;
  language: string;
  publishedAt: number;
  embedding?: number[];
}

/** candidate event side (loaded from DB) */
export interface CandidateSide {
  id: string;
  signature: string;
  entitySignature: string;
  entitySignatureCore: string;
  claimKeys: Set<string>;
  claimFps: Set<string>;
  topic?: string;
  lastSeenAt?: number;
  publishedAt?: number;
  embedding?: number[];
  /** candidate's dominant language — detected from its title */
  language?: string;
}

const VI_CHARS =
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** cheap title-level language guess — signature tokens are lang-agnostic
 *  so this only feeds the cross-language semantic band */
export function detectLanguage(text: string): "vi" | "en" {
  return VI_CHARS.test(text) ? "vi" : "en";
}

/** per-pair feature record — the full audit payload (Phase 0 export) */
export interface PairFeatures {
  lexicalSimilarity: number;
  semanticSimilarity?: number;
  coreEntitySimilarity: number;
  entitySimilarity: number;
  sharedCoreEntities: string[];
  sharedEntities: string[];
  nonHubSharedCore: string[];
  distinctiveClaimOverlap: number;
  genericClaimOverlap: number;
  sharedRareTokens: string[];
  sharedBigrams: string[];
  numberAgreement: boolean;
  numberConflict: boolean;
  timeDeltaHours: number;
  sameLanguage: boolean;
}

/* ------------------------------ constants --------------------------------- */

const MERGE_JACCARD = 0.55;
const MERGE_CLAIM_OVERLAP = 0.5;
/** signature floor that lets an exact generic-claim match merge */
const GENERIC_SIG_FLOOR = 0.3;
/** signature floor that lets a located pair merge on entity+tokens */
const ENTITY_SIG_FLOOR = 0.2;
/** ≥2 shared entities + Jaccard ≥ 0.6 merges even with no shared tokens */
const ENTITY_STRONG_SHARED = 2;
const ENTITY_STRONG_SIM = 0.6;

/**
 * Geographic entities name a beat, never an event — every VN outlet
 * covers "us + china" daily. Only non-geo entities (people, orgs,
 * competitions, companies) may serve as identity evidence. Topic-class
 * entities (drone, oil, AI…) are equally non-identifying: every second
 * conflict story involves UAVs, every market story involves oil.
 */
export const HUB_ENTITIES = new Set([
  "us",
  "un",
  "europe",
  "middleeast",
  "baltic",
  "redsea",
  "mientrung",
  "mienbac",
  "miennam",
  "taynguyen",
  "dbscl",
  "vietnam",
  "china",
  "japan",
  "southkorea",
  "northkorea",
  "taiwan",
  "hongkong",
  "thailand",
  "myanmar",
  "laos",
  "cambodia",
  "malaysia",
  "singapore",
  "indonesia",
  "philippines",
  "india",
  "pakistan",
  "bangladesh",
  "australia",
  "newzealand",
  "israel",
  "palestine",
  "iran",
  "iraq",
  "syria",
  "lebanon",
  "yemen",
  "saudi",
  "uae",
  "qatar",
  "turkey",
  "russia",
  "ukraine",
  "uk",
  "france",
  "germany",
  "italy",
  "spain",
  "poland",
  "netherlands",
  "belgium",
  "switzerland",
  "sweden",
  "norway",
  "denmark",
  "finland",
  "austria",
  "greece",
  "portugal",
  "ireland",
  "hungary",
  "czech",
  "romania",
  "canada",
  "mexico",
  "brazil",
  "argentina",
  "chile",
  "peru",
  "colombia",
  "venezuela",
  "cuba",
  "panama",
  "haiti",
  "egypt",
  "southafrica",
  "nigeria",
  "kenya",
  "sudan",
  "ethiopia",
  "morocco",
  "libya",
  "congo",
  "southsudan",
  "hanoi",
  "hcmc",
  "danang",
  "haiphong",
  "cantho",
  "hue",
  "nhatrang",
  "dalat",
  "quangninh",
  "hatinh",
  "nghean",
  "thanhhoa",
  "laocai",
  "langson",
  "caobang",
  "dienbien",
  "sonla",
  "gialai",
  "daklak",
  "angiang",
  "kiengiang",
  "camau",
  "binhduong",
  "dongnai",
  "bariavungtau",
  "bacninh",
  "phuquoc",
  "quangtri",
  "khanhhoa",
  "lamdong",
  "halong",
  // topic-class entities: corroborating context, never identity anchors
  "drone",
  "oil",
  "pipeline",
  "ai",
  "semiconductor",
  "trade_surplus",
  "song_hong",
  "pm",
  "eu",
  "nato",
  "asean",
  "brics",
  "g20",
  "opec",
  "imf",
  "worldbank",
  "wto",
  "who",
  // recurring multi-event series: an edition's umbrella, never one
  // incident ("ASIAD quarterfinal schedule" ≠ "ASIAD shooting final")
  "asiad",
  "olympic",
  "worldcup",
  "seagames",
]);

/** signature floor for entity merges whose shared entities are all hubs */
const HUB_SIG_FLOOR = 0.3;
/** a single shared hub entity needs strong headline support to merge */
const HUB_SINGLE_SIG_FLOOR = 0.4;
/** named individuals anchor an event — a shared person entity plus
 *  modest headline overlap is same-story evidence */
export const PERSON_ENTITIES = new Set([
  "trump",
  "putin",
  "zelensky",
  "xijinping",
  "kimjongun",
  "netanyahu",
  "modi",
  "milei",
  "lam",
  "biden",
  "macron",
  "hunsen",
  "kimsangsik",
]);
const PERSON_SIG_FLOOR = 0.2;
/** institutional/civic vocabulary repeats across UNRELATED stories —
 *  it can never be a "rare" identity token */
const RARE_TOKEN_EXCLUDE = new Set([
  "thuong",
  "truc",
  "trung",
  "quoc",
  "viet",
  "dang",
  "chinh",
  "nguoi",
  "cong",
  "giao",
  "thong",
  "duong",
  "benh",
  "vien",
  "truong",
  "sinh",
  "doanh",
  "nghiep",
  "kinh",
  "thanh",
  "tinh",
  "huyen",
  "ngay",
  "sang",
  "chieu",
  "tuan",
  "thang",
  // country/geo names recur across unrelated incidents — they are
  // entities, not identity tokens
  "ukraine",
  "russia",
  "vietnam",
  "trungquoc",
  "asean",
]);
/** a shared uncommon token (storm name, codename) + modest overlap merges */
const RARE_TOKEN_MIN_LEN = 5;
const RARE_SIG_FLOOR = 0.2;
/** schedule/wire formula vocabulary — a bigram made only of these is
 *  boilerplate ("lịch thi đấu"), not event identity */
const BIGRAM_FORMULA = new Set([
  "lich",
  "thi",
  "dau",
  "ngay",
  "gio",
  "truc",
  "tiep",
  "ket",
  "qua",
  "cap",
  "nhat",
  "moi",
  "video",
  "anh",
  "bai",
  "hoi",
  "nghi",
  "tin",
]);
/** numbers that identify an event across languages — years and round
 *  figures are too common to count */
const isDistinctiveNumber = (t: string) =>
  /^\d{2,3}$/.test(t) &&
  !/^(1[0-9]|[2-9]0|25|50|100|200|300|400|500|1000|202\d)$/.test(t);
/** fact types bound to ONE incident — identical value + no location on
 *  either side is legitimate same-event evidence; recurring metrics are not */
const INCIDENT_SCOPED = new Set([
  "deaths",
  "injured",
  "missing",
  "evacuated",
  "flights_cancelled",
  "magnitude",
]);

/* ------------------------------ primitives -------------------------------- */

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

export const isDistinctiveKey = (key: string) => key.includes("|");
// canonValue: "20" (string) and 20 (number) are the same fact — a raw
// JSON.stringify fingerprint would recall-miss and split the event
export const genericFingerprint = (c: ExtractedClaim) =>
  `${c.claimKey}|${JSON.stringify(canonValue(c.value))}`;

/**
 * Resolver fingerprint — topic | sorted tokens | number tokens | bigrams.
 * The column exists so the matcher can be swapped to pgvector similarity
 * without a schema change.
 */
export function eventSignature(topic: string, title: string): string {
  const raw = normalizeText(title).split(" ").filter(Boolean);
  const toks = raw.filter((t) => t.length >= 3 && !/^\d+$/.test(t)).sort();
  // number tokens ride in a third segment — "46%" is identity evidence
  // across languages even when no lexical token survives translation.
  // bare years are edition noise, not identity
  const nums = raw
    .filter((t) => /^\d{2,3}$/.test(t) && !/^(19|20)\d\d$/.test(t))
    .sort();
  // consecutive-token bigrams capture phrases unigrams lose:
  // "bóng đá nam" is one facet of a story, not three loose words
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    const bg = `${raw[i]}_${raw[i + 1]}`;
    if (bg.length < 7) continue;
    if (BIGRAM_FORMULA.has(raw[i]) && BIGRAM_FORMULA.has(raw[i + 1])) {
      continue;
    }
    // numeric bigrams are dates/editions ("asiad_2026"), not identity
    if (/^\d+$/.test(raw[i]) || /^\d+$/.test(raw[i + 1])) continue;
    // a bigram that is just a place or person name adds nothing over the
    // entity signature — "viet_nam", "trung_quoc", "ong_trump" name beats
    const bgEnts = entitySignature(`${raw[i]} ${raw[i + 1]}`)
      .split(" ")
      .filter(Boolean);
    if (
      bgEnts.length > 0 &&
      bgEnts.every((e) => HUB_ENTITIES.has(e) || PERSON_ENTITIES.has(e))
    ) {
      continue;
    }
    bigrams.push(bg);
  }
  return `${topic}|${toks.join(" ")}|${nums.join(" ")}|${bigrams.sort().join(" ")}`;
}

/**
 * Domain-aware retrieval window (Phase 7 seam). Breaking incidents cool
 * fast; policy/economy stories evolve over days. Values are deliberately
 * conservative — widening a window trades precision for recall.
 */
export function eventTimeWindow(topic: string): number {
  switch (topic) {
    case "business":
    case "technology":
    case "tech":
    case "science":
      return 120; // earnings/policy cycles evolve over days
    case "sports":
      return 48; // fixtures are tightly time-scoped
    default:
      return 72; // world/vietnam/breaking default
  }
}
/** widest retrieval window — SQL fetches this superset; decide() applies
 *  the per-domain gate inside the pair check */
export const RESOLVER_MAX_WINDOW_HOURS = 168;

/* --------------------------- feature builders ----------------------------- */

export function buildIncomingSide(
  cluster: StoryCluster,
  claims: ExtractedClaim[],
  embedding?: number[],
): IncomingSide {
  const signature = eventSignature(cluster.topic, cluster.title);
  const sigParts = signature.split("|");
  const entSig = entitySignature(`${cluster.title} ${cluster.summary}`);
  // title-only entities are the identity; summary entities corroborate —
  // wire boilerplate in summaries must not mint event identity
  const entCoreSig = entitySignature(cluster.title);
  return {
    signature,
    sigTokens: new Set((sigParts[1] ?? "").split(" ").filter(Boolean)),
    numTokens: new Set((sigParts[2] ?? "").split(" ").filter(Boolean)),
    bigTokens: new Set((sigParts[3] ?? "").split(" ").filter(Boolean)),
    entTokens: new Set(entSig.split(" ").filter(Boolean)),
    entCoreTokens: new Set(entCoreSig.split(" ").filter(Boolean)),
    distinctiveKeys: new Set(
      claims.map((c) => c.claimKey).filter(isDistinctiveKey),
    ),
    genericFps: new Set(
      claims
        .filter((c) => !isDistinctiveKey(c.claimKey))
        .map(genericFingerprint),
    ),
    topic: cluster.topic,
    language: cluster.leadArticle.language ?? "vi",
    publishedAt: Date.parse(
      cluster.publishedAt || cluster.leadArticle.publishedAt,
    ),
    embedding,
  };
}

export function computeFeatures(
  inc: IncomingSide,
  cand: CandidateSide,
): PairFeatures {
  const cSigParts = cand.signature.split("|");
  const cTokens = new Set((cSigParts[1] ?? "").split(" ").filter(Boolean));
  const cNums = new Set((cSigParts[2] ?? "").split(" ").filter(Boolean));
  const cBigs = new Set((cSigParts[3] ?? "").split(" ").filter(Boolean));
  const cEnt = new Set(cand.entitySignature.split(" ").filter(Boolean));
  const cCore = new Set(
    (cand.entitySignatureCore || cand.entitySignature)
      .split(" ")
      .filter(Boolean),
  );

  const sigSim = jaccard(inc.sigTokens, cTokens);
  const coreShared = [...inc.entCoreTokens].filter((e) => cCore.has(e));
  const fullShared = [...inc.entTokens].filter((e) => cEnt.has(e));
  const numShared = [...inc.numTokens].filter(
    (t) => cNums.has(t) && isDistinctiveNumber(t),
  );
  // a contradiction needs figures on BOTH sides that share nothing —
  // a number present on only one side (an edition marker like "ASEAN 47",
  // a detail one report omitted) is missing evidence, not conflicting
  const numberConflict =
    inc.numTokens.size > 0 &&
    cNums.size > 0 &&
    ![...inc.numTokens].some((t) => cNums.has(t));

  let distinctiveOverlap = 0;
  let genericOverlap = 0;
  if (inc.distinctiveKeys.size > 0) {
    const shared = [...inc.distinctiveKeys].filter((k) =>
      cand.claimKeys.has(k),
    ).length;
    distinctiveOverlap = shared / inc.distinctiveKeys.size;
  }
  if (inc.genericFps.size > 0) {
    const shared = [...inc.genericFps].filter((f) =>
      cand.claimFps.has(f),
    ).length;
    genericOverlap = shared / inc.genericFps.size;
  }

  const sharedRare = [...inc.sigTokens].filter(
    (t) =>
      cTokens.has(t) &&
      t.length >= RARE_TOKEN_MIN_LEN &&
      !/^\d+$/.test(t) &&
      !RARE_TOKEN_EXCLUDE.has(t),
  );
  const sharedBigrams = [...inc.bigTokens].filter((b) => cBigs.has(b));

  const semantic =
    inc.embedding && cand.embedding
      ? cosine(inc.embedding, cand.embedding)
      : undefined;

  // publish-vs-publish only — last_seen_at is the ingestion clock and is
  // never comparable to a publication timestamp (bench fixtures carry
  // real-world publish dates far from "now")
  const timeDeltaHours =
    cand.publishedAt !== undefined
      ? Math.abs(inc.publishedAt - cand.publishedAt) / 3_600_000
      : 0;

  return {
    lexicalSimilarity: sigSim,
    semanticSimilarity: semantic,
    coreEntitySimilarity: jaccard(inc.entCoreTokens, cCore),
    entitySimilarity: jaccard(inc.entTokens, cEnt),
    sharedCoreEntities: coreShared,
    sharedEntities: fullShared,
    nonHubSharedCore: coreShared.filter((e) => !HUB_ENTITIES.has(e)),
    distinctiveClaimOverlap: distinctiveOverlap,
    genericClaimOverlap: genericOverlap,
    sharedRareTokens: sharedRare,
    sharedBigrams,
    numberAgreement: numShared.length > 0,
    numberConflict,
    timeDeltaHours,
    sameLanguage:
      (cand.language ?? detectLanguage(cand.entitySignature)) === inc.language,
  };
}

/* -------------------------------- decide ---------------------------------- */

/**
 * Stage-B pair decision. Returns merge | split | ambiguous; persistence
 * maps ambiguous → split (precision-safe) but telemetry keeps the flag.
 */
export function decide(
  inc: IncomingSide,
  cand: CandidateSide,
): ResolverDecision {
  const f = computeFeatures(inc, cand);
  const reasons: string[] = [];
  const hardBlocks: string[] = [];
  const sigSim = f.lexicalSimilarity;
  const coreShared = f.sharedCoreEntities;
  const entityEvidence =
    f.nonHubSharedCore.length > 0 ||
    sigSim >= (coreShared.length >= 2 ? HUB_SIG_FLOOR : HUB_SINGLE_SIG_FLOOR);
  const personShared = coreShared.some((e) => PERSON_ENTITIES.has(e));
  const entityBlocked =
    inc.entCoreTokens.size > 0 &&
    (cand.entitySignatureCore || cand.entitySignature)
      .split(" ")
      .filter(Boolean).length > 0 &&
    coreShared.length === 0;
  const strictNumConflict = f.numberConflict;
  const semantic = f.semanticSimilarity;

  if (entityBlocked)
    hardBlocks.push(
      `entity_blocked: core entities share nothing (${[...inc.entCoreTokens]} vs ${cand.entitySignatureCore})`,
    );
  if (strictNumConflict)
    reasons.push(
      `num_conflict: figures disjoint (weak paths vetoed, identity paths exempt)`,
    );

  // time gate — different domains cool at different rates; only armed
  // when the candidate's own publication clock is known
  const window = eventTimeWindow(inc.topic);
  if (cand.publishedAt !== undefined && f.timeDeltaHours > window) {
    hardBlocks.push(
      `time_window: ${f.timeDeltaHours.toFixed(0)}h > ${window}h for ${inc.topic}`,
    );
    return {
      decision: "split",
      path: "time_window",
      score: 0,
      reasons,
      hardBlocks,
      features: f,
    };
  }

  // a merge decision's score ranks competing candidates — the strongest
  // signal across every feature, matching the previous best-score order
  const mergeScore = () =>
    Math.max(
      sigSim,
      f.coreEntitySimilarity,
      f.entitySimilarity,
      f.distinctiveClaimOverlap,
      f.genericClaimOverlap,
      semantic ?? 0,
    );
  const merge = (
    path: string,
    _score: number,
    why: string,
  ): ResolverDecision => ({
    decision: "merge",
    path,
    score: mergeScore(),
    reasons: [...reasons, why],
    hardBlocks,
    features: f,
  });

  // — identity paths (immune to entity contradiction + numeric veto) —
  if (sigSim >= MERGE_JACCARD)
    return merge(
      "headline",
      sigSim,
      `headline jaccard ${sigSim.toFixed(2)} ≥ ${MERGE_JACCARD}`,
    );
  if (f.sharedRareTokens.length > 0 && sigSim >= RARE_SIG_FLOOR)
    return merge(
      "rare_token",
      sigSim,
      `rare token ${f.sharedRareTokens[0]} + sig ${sigSim.toFixed(2)}`,
    );
  if (personShared && sigSim >= PERSON_SIG_FLOOR)
    return merge("person", sigSim, `person anchor + sig ${sigSim.toFixed(2)}`);
  if (
    sigSim >= 0.1 &&
    f.sharedBigrams.length > 0 &&
    f.nonHubSharedCore.length > 0
  )
    return merge(
      "bigram_entity",
      sigSim,
      `bigram "${f.sharedBigrams[0]}" + non-hub entity`,
    );
  if (f.numberAgreement && coreShared.length >= 2)
    return merge(
      "num_entity",
      sigSim,
      `distinctive number + ≥2 shared entities`,
    );

  const crossLingual =
    sigSim < 0.1 &&
    !strictNumConflict &&
    f.nonHubSharedCore.length > 0 &&
    f.sharedEntities.length >= 2 &&
    f.coreEntitySimilarity >= 0.4;
  if (crossLingual)
    return merge(
      "cross_lingual",
      f.coreEntitySimilarity,
      "zero-lexical cross-language entity match",
    );

  if (
    inc.distinctiveKeys.size > 0 &&
    f.distinctiveClaimOverlap >= MERGE_CLAIM_OVERLAP
  )
    return merge(
      "distinctive_claim",
      f.distinctiveClaimOverlap,
      `distinctive claim overlap ${f.distinctiveClaimOverlap.toFixed(2)}`,
    );

  // — semantic path: a strong cosine alone merges; a medium cosine needs
  //   an entity/claim anchor (dense+sparse+entity > any one signal) —
  if (semantic !== undefined && !entityBlocked && !strictNumConflict) {
    // measured bands (semantic-dist.json): diff max 0.861, xlang diff max 0.675
    if (semantic >= 0.87)
      return merge(
        "semantic_strong",
        semantic,
        `cosine ${semantic.toFixed(2)} ≥ 0.87, no contradiction`,
      );
    if (!f.sameLanguage && semantic >= 0.78 && f.sharedEntities.length >= 1)
      return merge(
        "semantic_xlang",
        semantic,
        `cosine ${semantic.toFixed(2)} cross-language + shared entity`,
      );
    if (
      semantic >= 0.72 &&
      (f.nonHubSharedCore.length > 0 ||
        personShared ||
        f.distinctiveClaimOverlap >= MERGE_CLAIM_OVERLAP ||
        (f.numberAgreement && coreShared.length >= 2))
    )
      return merge(
        "semantic_anchored",
        semantic,
        `cosine ${semantic.toFixed(2)} + entity/claim anchor`,
      );
  }

  // — entity-corroborated paths (vetoed by contradiction) —
  if (!entityBlocked) {
    // conflicting figures + only beat-level (hub) entities shared =
    // different incidents of the same kind ("200 UAV Kursk" vs "T-72
    // Donetsk"). Identity paths already returned above; a non-hub anchor
    // would survive, but hub-only corroboration may not.
    const numVeto =
      strictNumConflict && (sigSim < 0.2 || f.nonHubSharedCore.length === 0);
    if (numVeto)
      hardBlocks.push(
        "num_conflict_entity: disjoint figures and no non-hub anchor",
      );
    const numOk = !numVeto;
    if (
      numOk &&
      ((f.coreEntitySimilarity >= 0.5 &&
        sigSim >= ENTITY_SIG_FLOOR &&
        entityEvidence) ||
        (coreShared.length >= ENTITY_STRONG_SHARED &&
          f.coreEntitySimilarity >= ENTITY_STRONG_SIM &&
          entityEvidence))
    )
      return merge(
        "entity",
        Math.max(f.coreEntitySimilarity, sigSim),
        `entity corroborated sig=${sigSim.toFixed(2)} core=${f.coreEntitySimilarity.toFixed(2)}`,
      );
    if (
      inc.genericFps.size > 0 &&
      f.genericClaimOverlap >= MERGE_CLAIM_OVERLAP &&
      (f.entitySimilarity > 0 ||
        sigSim >= GENERIC_SIG_FLOOR ||
        (inc.entTokens.size === 0 &&
          new Set(cand.entitySignature.split(" ").filter(Boolean)).size === 0 &&
          [...inc.genericFps].every((g) =>
            INCIDENT_SCOPED.has(g.split("|")[0]),
          )))
    )
      return merge(
        "generic_claim",
        f.genericClaimOverlap,
        `exact claim fingerprint ${f.genericClaimOverlap.toFixed(2)}`,
      );
  }

  // — ambiguous band: real signal present but below merge bars —
  const borderline =
    semantic !== undefined && semantic >= 0.72 && !entityBlocked;
  if (borderline)
    return {
      decision: "ambiguous",
      path: "semantic_ambiguous",
      score: semantic!,
      reasons: [...reasons, `cosine ${semantic!.toFixed(2)} without anchor`],
      hardBlocks,
      features: f,
    };
  return {
    decision: "split",
    path: entityBlocked ? "entity_blocked" : "no_path",
    score: Math.max(
      sigSim,
      f.entitySimilarity,
      f.distinctiveClaimOverlap,
      f.genericClaimOverlap,
      semantic ?? 0,
    ),
    reasons: reasons.length
      ? reasons
      : [
          `no merge path: sig=${sigSim.toFixed(2)} ent=${f.coreEntitySimilarity.toFixed(2)}`,
        ],
    hardBlocks,
    features: f,
  };
}

/* ----------------------- semantic representation -------------------------- */

import { createHash } from "node:crypto";

/** rep text size cap — enough for a few headlines, never a dump */
const REP_MAX_CHARS = 700;
const REP_MAX_HEADLINES = 4;
const REP_MAX_ENTITIES = 12;
const REP_MAX_CLAIMS = 6;

/**
 * Stable event representation for embedding (Phase 3/12). Bounded and
 * content-addressed: canonical title + summary + a few representative
 * evidence headlines + entity slugs + claim labels. An ongoing event may
 * rotate its recent headlines but can never union-in the whole topic —
 * entity/claim lists are capped so drift cannot absorb a beat.
 */
export function eventRepText(parts: {
  title: string;
  summary?: string;
  headlines?: string[];
  entities?: string[];
  claimLabels?: string[];
}): string {
  // canonical ordering — the same logical event must produce the same
  // rep text (and hash) regardless of upstream collection order
  const headlines = [...new Set(parts.headlines ?? [])]
    .sort()
    .slice(0, REP_MAX_HEADLINES);
  const entities = [...new Set(parts.entities ?? [])]
    .sort()
    .slice(0, REP_MAX_ENTITIES);
  const claims = [...new Set(parts.claimLabels ?? [])]
    .sort()
    .slice(0, REP_MAX_CLAIMS);
  const seg: string[] = [parts.title];
  if (parts.summary) seg.push(parts.summary.slice(0, 240));
  if (headlines.length) seg.push(headlines.join(" | "));
  if (entities.length) seg.push(entities.join(" "));
  if (claims.length) seg.push(claims.join(" | "));
  return seg.join(" — ").slice(0, REP_MAX_CHARS);
}

/** representation for an incoming cluster (same recipe, bounded) */
export function clusterRepTextV2(
  cluster: StoryCluster,
  claims: ExtractedClaim[],
): string {
  return eventRepText({
    title: cluster.title,
    summary: cluster.summary || cluster.leadArticle.summary,
    headlines: cluster.articles.map((a) => a.title),
    entities: entitySignature(`${cluster.title} ${cluster.summary}`)
      .split(" ")
      .filter(Boolean),
    claimLabels: claims.map(
      (c) => `${c.claimKey}=${JSON.stringify(canonValue(c.value))}`,
    ),
  });
}

export function repHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
