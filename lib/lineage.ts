/**
 * Information Lineage V1 — deterministic origin attribution.
 *
 * The question: did outlet B independently gather this fact, or is B's
 * document a descendant of document A (wire copy, quote, rewrite,
 * press-release derivative)? Precision beats recall: a false "independent"
 * inflates confidence far more than a missed lineage link.
 *
 * V1 uses no LLM: attribution phrases (rule), text fingerprinting
 * (similarity), and primary-document presence (rule). 'original' is a
 * POSITIVE assertion of independence — a doc earns it only after being
 * evaluated against other coverage with no senior doc looking related.
 * Nothing to compare, an unresolvable citation, or gray-zone similarity
 * all yield 'unknown'; "no detected parent" is never independence.
 */

export type LineageRelation =
  | "original"
  | "syndicated"
  | "quoted"
  | "rewritten"
  | "press_release_based"
  | "unknown";

export interface LineageDoc {
  documentId: string;
  /** canonical publisher name (never the discovery provider) */
  source: string;
  /** 'primary' | 'publisher' | 'community' | 'aggregator' */
  sourceKind?: string;
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
  language?: string;
}

export interface LineageAssertion {
  parentDocumentId: string | null;
  relation: LineageRelation;
  confidence: number;
  method: "rule" | "similarity";
  evidence: Record<string, unknown>;
}

/* ------------------------- attribution phrases ------------------------- */

/** outlet names a citation can point at → canonical source name */
const ATTRIBUTABLE_SOURCES: [RegExp, string][] = [
  [/\breuters\b/i, "Reuters"],
  [/\b(associated press|\bap\b)/i, "AP"],
  [/\bafp\b/i, "AFP"],
  [/\bbloomberg\b/i, "Bloomberg"],
  [/\b(bbc|đài bbc)\b/i, "BBC"],
  [/\bcnbc\b/i, "CNBC"],
  [/\bkyodo\b/i, "Kyodo"],
  [/\byonhap\b/i, "Yonhap"],
  [/\btass\b/i, "TASS"],
  [/\bdpa\b/i, "DPA"],
  [/\b(ttxvn|thông tấn xã việt nam|vietnamplus)\b/i, "VietnamPlus"],
  [/\b(xinhua|tân hoa xã)\b/i, "Xinhua"],
  [/\b(ansa|efe|pap|aap|pa media)\b/i, ""], // wire named but unregistered — still a citation signal
];

const VI_ATTRIBUTION =
  /(?:theo|dẫn|trích dẫn|theo lời|theo thông tin (?:từ|của)|hãng tin)\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ .]{1,30}?)(?:\s+(?:cho biết|đưa tin|report|cho hay)|[,.])/i;
const EN_ATTRIBUTION =
  /(?:according to|citing|per|quoting)\s+([A-Z][A-Za-z .]{1,30}?)(?:\s+(?:report|said|reported|stated)|[,.])/i;
const EN_REPORTED_BY = /\b([A-Z][A-Za-z]{2,20})\s+reported\b/i;

/** phrases pointing at a primary/official document rather than an outlet */
const PRESS_RELEASE_PHRASE =
  /theo (?:thông cáo|thông tin báo chí|tuyên bố|công văn|nghị định|quyết định|văn bản)(?:\s+(?:của|từ|phát hành bởi)\s+([^,.]{2,40}))?/i;
const EN_PRESS_RELEASE_PHRASE =
  /in a (?:press release|statement|filing|official statement|regulatory filing)|according to (?:an? |the )?(?:official )?(?:press release|filing|statement|company statement)(?:\s+(?:from|by|issued by)\s+([A-Z][A-Za-z .]{1,30}))?/i;

export interface Attribution {
  /** canonical outlet name if one was named; '' for unnamed wire */
  outlet: string;
  /** primary-document citation (thông cáo/filing/statement) */
  primary: boolean;
  /** the matched phrase, for audit */
  phrase: string;
}

export function detectAttribution(text: string): Attribution | null {
  for (const [re, canonical] of ATTRIBUTABLE_SOURCES) {
    if (re.test(text)) return { outlet: canonical, primary: false, phrase: re.source };
  }
  const pr = text.match(PRESS_RELEASE_PHRASE) ?? text.match(EN_PRESS_RELEASE_PHRASE);
  if (pr) return { outlet: "", primary: true, phrase: pr[0] };
  const vi = text.match(VI_ATTRIBUTION);
  if (vi?.[1]) return { outlet: vi[1].trim(), primary: false, phrase: vi[0] };
  const en = text.match(EN_ATTRIBUTION) ?? text.match(EN_REPORTED_BY);
  if (en?.[1]) return { outlet: en[1].trim(), primary: false, phrase: en[0] };
  return null;
}

/* --------------------------- text fingerprints ------------------------- */

const STOP_VI_EN = new Set(
  "the a an and or of to in on for with by at from as is are was were be been it its that this " +
    "và của cho các trong trên với từ theo là được đã có một những này đó khi tại về".split(
      " ",
    ),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics — vi/en share surface forms
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_VI_EN.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function shingles(s: string, n = 3): Set<string> {
  const t = tokens(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

const YEAR_RE = /^(19|20)\d{2}$/;
function numbers(s: string): Set<string> {
  return new Set(
    (s.match(/\d[\d.,%]*/g) ?? [])
      .map((n) => n.replace(/[.,]/g, ""))
      .filter((n) => n.length >= 2 && !YEAR_RE.test(n)),
  );
}

export interface SimScores {
  titleSim: number;
  summarySim: number;
  sharedNumbers: number;
  /** both docs carry figures but share none — the child disputes the
   *  parent's facts, which a copy/rewrite does not do */
  numberConflict: boolean;
  /** every figure in the child is explained by the parent — across
   *  languages this is the translation fingerprint; within one language
   *  it corroborates derivation */
  numbersContained: boolean;
  lagHours: number; // child.publishedAt − candidate.publishedAt
}

export function similarity(child: LineageDoc, cand: LineageDoc): SimScores {
  const titleSim = jaccard(new Set(tokens(child.title)), new Set(tokens(cand.title)));
  const summarySim = jaccard(shingles(child.summary), shingles(cand.summary));
  const cn = numbers(child.title + " " + child.summary);
  const pn = numbers(cand.title + " " + cand.summary);
  let sharedNumbers = 0;
  for (const n of cn) if (pn.has(n)) sharedNumbers++;
  const lagHours =
    (Date.parse(child.publishedAt) - Date.parse(cand.publishedAt)) / 3_600_000;
  return {
    titleSim,
    summarySim,
    sharedNumbers,
    numberConflict: cn.size > 0 && pn.size > 0 && sharedNumbers === 0,
    numbersContained: cn.size > 0 && sharedNumbers === cn.size,
    lagHours,
  };
}

/* ------------------------------ classifier ----------------------------- */

// A parent can't be much older than the child — past this window the
// texts are similar by coincidence, not derivation.
const MAX_PARENT_LAG_HOURS = 72;
// Precision-first thresholds — tuned on bench/lineage.jsonl.
const SYNDICATED_TITLE_SIM = 0.8;
const REWRITTEN_TITLE_SIM = 0.55;
const REWRITTEN_SUMMARY_SIM = 0.35;
const ATTR_CONF = 0.9;
const PRIMARY_ATTR_CONF = 0.85;
// Independence-clear zone: a senior doc above this similarity but under
// the derivation bar is conflicting evidence → 'unknown', never 'original'.
const INDEPENDENT_CLEAR_TITLE_SIM = 0.35;
// Bump when classification semantics change — stamped on every assertion
// row so audit can tell which rules produced it.
export const CLASSIFIER_VERSION = "v2";

/**
 * Classify one document against candidate parents. Candidates must come
 * from the same event/context pool — callers filter by time; same-source
 * candidates are allowed (self-editions rewrite) but can never yield
 * 'syndicated'.
 */
export function classifyLineage(
  child: LineageDoc,
  candidates: LineageDoc[],
): LineageAssertion {
  // a primary document is evidence itself — it can cite ANOTHER primary
  // (a filing referencing a statute) but is never a publisher's rewrite
  if (child.sourceKind === "primary") {
    return {
      parentDocumentId: null,
      relation: "original",
      confidence: 0.9,
      method: "rule",
      evidence: { primary: true },
    };
  }
  const text = `${child.title}. ${child.summary}`;

  // --- similarity first: a verbatim copy is derived from its text source
  // even when the copied text itself attributes elsewhere (chain keeps
  // the true parent, not the parent-of-the-parent)
  let best: { cand: LineageDoc; s: SimScores } | null = null;
  let maxSeniorSim = 0;
  for (const cand of candidates) {
    if (cand.documentId === child.documentId) continue;
    if (!eligibleParent(child, cand)) continue;
    const s = similarity(child, cand);
    if (s.titleSim > maxSeniorSim) maxSeniorSim = s.titleSim;
    if (
      s.titleSim >= REWRITTEN_TITLE_SIM &&
      (!best || s.titleSim > best.s.titleSim)
    ) {
      best = { cand, s };
    }
  }
  if (best && best.s.titleSim >= SYNDICATED_TITLE_SIM) {
    const { cand, s } = best;
    const sameSource = cand.source === child.source;
    if (
      (s.sharedNumbers >= 1 || s.summarySim >= 0.3 || s.titleSim >= 0.9) &&
      !sameSource &&
      !s.numberConflict
    ) {
      return {
        parentDocumentId: cand.documentId,
        relation: "syndicated",
        confidence: Math.min(0.95, s.titleSim + 0.05),
        method: "similarity",
        evidence: { ...s, candidate: cand.source },
      };
    }
  }

  // --- rule: explicit attribution -------------------------------------
  // a doc "citing" its own outlet ("The BBC has confirmed…") is not
  // attributing a parent — self-references never constrain lineage
  let attr = detectAttribution(text);
  if (
    attr?.outlet &&
    (child.source.toLowerCase().includes(attr.outlet.toLowerCase()) ||
      attr.outlet.toLowerCase().includes(child.source.toLowerCase()))
  ) {
    attr = null;
  }
  if (attr) {
    if (attr.primary) {
      const prim = candidates.find(
        (c) => c.sourceKind === "primary" && eligibleParent(child, c),
      );
      if (prim)
        return {
          parentDocumentId: prim.documentId,
          relation: "press_release_based",
          confidence: PRIMARY_ATTR_CONF,
          method: "rule",
          evidence: { phrase: attr.phrase, candidate: prim.source },
        };
    } else {
      const want = attr.outlet.toLowerCase();
      const cited = candidates.find(
        (c) =>
          c.source.toLowerCase() === want ||
          (want && c.source.toLowerCase().includes(want)) ||
          (want.length > 2 && want.includes(c.source.toLowerCase())),
      );
      if (cited && eligibleParent(child, cited))
        return {
          parentDocumentId: cited.documentId,
          relation: "quoted",
          confidence: ATTR_CONF,
          method: "rule",
          evidence: { phrase: attr.phrase, outlet: attr.outlet },
        };
    }
  }

  // rewritten: clearly related text but not verbatim. Numbers are a bonus
  // signal, not a requirement — most stories carry no figures at all.
  if (
    best &&
    best.s.titleSim >= REWRITTEN_TITLE_SIM &&
    !best.s.numberConflict &&
    (best.s.summarySim >= REWRITTEN_SUMMARY_SIM ||
      (best.s.titleSim >= 0.65 && best.s.sharedNumbers >= 1) ||
      best.s.titleSim >= 0.7)
  ) {
    return {
      parentDocumentId: best.cand.documentId,
      relation: "rewritten",
      confidence: 0.65,
      method: "similarity",
      evidence: { ...best.s, candidate: best.cand.source },
    };
  }

  // --- origin vs unknown -------------------------------------------------
  // 'original' is a positive assertion: the doc was compared against
  // other coverage and NO senior doc looks related (similarity below the
  // gray zone). Weaker evidence stays 'unknown' — it must never inflate
  // the confirmed-origin count.
  const others = candidates.filter((c) => c.documentId !== child.documentId);
  if (others.length === 0) {
    return {
      parentDocumentId: null,
      relation: "unknown",
      confidence: 0.3,
      method: "rule",
      evidence: { reason: "no_evidence", evaluated: 0 },
    };
  }
  if (attr) {
    // cites an outlet/primary we can't resolve to a candidate — the true
    // parent may exist but is unobserved; independence is unproven
    return {
      parentDocumentId: null,
      relation: "unknown",
      confidence: 0.35,
      method: "rule",
      evidence: {
        reason: "dangling_attribution",
        outlet: attr.outlet,
        phrase: attr.phrase,
      },
    };
  }
  // cross-language suspicion: a translation carries every figure of the
  // source text while the surface tokens no longer match. Lexically we
  // can't prove derivation — but we CAN'T confirm independence either,
  // so the doc stays unresolved rather than minting a false origin.
  const suspectTranslation = candidates.some((c) => {
    if (!eligibleParent(child, c)) return false;
    if ((c.language ?? "vi") === (child.language ?? "vi")) return false;
    return similarity(child, c).numbersContained;
  });
  if (suspectTranslation) {
    return {
      parentDocumentId: null,
      relation: "unknown",
      confidence: 0.4,
      method: "rule",
      evidence: { reason: "possible_translation", evaluated: others.length },
    };
  }
  // conflicting figures: a senior doc on the same event carrying a
  // disjoint set of numbers means the texts disagree on facts — neither
  // derivation nor independence can be proven → unresolved
  const seniorConflict = candidates.some(
    (c) => eligibleParent(child, c) && similarity(child, c).numberConflict,
  );
  if (seniorConflict) {
    return {
      parentDocumentId: null,
      relation: "unknown",
      confidence: 0.4,
      method: "rule",
      evidence: { reason: "conflicting_figures", evaluated: others.length },
    };
  }
  if (maxSeniorSim >= INDEPENDENT_CLEAR_TITLE_SIM) {
    // gray zone: similar enough to a senior doc to be related, not
    // similar enough to derive — includes disputed-figure near-copies
    return {
      parentDocumentId: null,
      relation: "unknown",
      confidence: 0.4,
      method: "rule",
      evidence: {
        reason: "conflicting_similarity",
        titleSim: maxSeniorSim,
        evaluated: others.length,
      },
    };
  }
  return {
    parentDocumentId: null,
    relation: "original",
    confidence: 0.6,
    method: "rule",
    evidence: { evaluated: others.length, maxSeniorSim },
  };
}

function inWindow(child: LineageDoc, cand: LineageDoc): boolean {
  const lag =
    (Date.parse(child.publishedAt) - Date.parse(cand.publishedAt)) / 3_600_000;
  return lag >= 0 && lag <= MAX_PARENT_LAG_HOURS;
}

/**
 * A derivation parent must be *senior* to the child: published earlier,
 * or — for identical timestamps — ordered before it by document id.
 * Without this, two same-text docs in one batch can point at each other
 * (a 2-cycle) and the true wire root gets marked derived.
 */
function isSenior(child: LineageDoc, cand: LineageDoc): boolean {
  const lag = Date.parse(child.publishedAt) - Date.parse(cand.publishedAt);
  return lag > 0 || (lag === 0 && cand.documentId < child.documentId);
}

function eligibleParent(child: LineageDoc, cand: LineageDoc): boolean {
  return inWindow(child, cand) && isSenior(child, cand);
}

/* -------------------------- origin resolution -------------------------- */

/**
 * Group documents by information origin. A doc's origin = its lineage
 * root: follow parent chains to the ancestor (cycle-safe, depth-capped).
 * Returns documentId → originDocumentId.
 */
export function resolveOrigins(
  assertions: Map<string, LineageAssertion>,
): Map<string, string> {
  const origins = new Map<string, string>();
  const rootOf = (id: string, depth = 0): string => {
    if (depth > 8) return id; // cycle guard
    const a = assertions.get(id);
    if (!a || !a.parentDocumentId || a.relation === "original") return id;
    return rootOf(a.parentDocumentId, depth + 1);
  };
  for (const id of assertions.keys()) origins.set(id, rootOf(id));
  return origins;
}

/* --------------------------- independence ------------------------------ */

export interface EvidenceIndependence {
  rawSources: number;
  /** lineage roots whose root doc carries a positive 'original'
   *  assertion — 'unknown' roots NEVER count here */
  confirmedIndependentOrigins: number;
  /** documents with unresolved lineage ('unknown' or no assertion) —
   *  each is its own unresolved root until evidence says otherwise */
  unresolvedOrigins: number;
  /** roots whose root document is a primary source */
  primaryOrigins: number;
  /** documents derived from another document in the graph */
  derivedDocuments: number;
}

const DERIVED = new Set<LineageRelation>([
  "syndicated",
  "quoted",
  "rewritten",
  "press_release_based",
]);

export function independence(
  docs: LineageDoc[],
  assertions: Map<string, LineageAssertion>,
): EvidenceIndependence {
  const origins = resolveOrigins(assertions);
  const byId = new Map(docs.map((d) => [d.documentId, d]));
  const rootIds = new Set(origins.values());
  // one newsroom = one information origin: several asserted-original
  // documents from the same source still count once
  const confirmedSources = new Set<string>();
  const primarySources = new Set<string>();
  for (const rootId of rootIds) {
    const rootDoc = byId.get(rootId);
    if (!rootDoc) continue;
    if (assertions.get(rootId)?.relation === "original")
      confirmedSources.add(rootDoc.source);
    if (rootDoc.sourceKind === "primary") primarySources.add(rootDoc.source);
  }
  let derived = 0;
  let unresolved = 0;
  for (const d of docs) {
    const rel = assertions.get(d.documentId)?.relation;
    if (rel && DERIVED.has(rel)) derived++;
    else if (!rel || rel === "unknown") unresolved++;
  }
  return {
    rawSources: new Set(docs.map((d) => d.source)).size,
    confirmedIndependentOrigins: confirmedSources.size,
    unresolvedOrigins: unresolved,
    primaryOrigins: primarySources.size,
    derivedDocuments: derived,
  };
}
