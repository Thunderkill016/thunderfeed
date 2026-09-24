/**
 * Builds bench/lineage-real.jsonl — an externally-grounded evaluation
 * set from REAL articles already ingested by ThunderFeed (the resolver
 * corpus in bench/pairs.labeled.jsonl carries true URLs, timestamps and
 * summaries from live feeds).
 *
 * Labels are assigned by the documented rules below — NOT by
 * classifyLineage, and not by a human reviewer. This is an
 * externally-grounded evaluation set, not human gold:
 *
 *   label == "same" (same concrete event, per the audited corpus):
 *     same source                          → rewritten   (own follow-up)
 *     child text cites the other outlet    → quoted      (attribution)
 *     titleSim ≥ 0.75                      → syndicated  (near-verbatim)
 *     titleSim ≥ 0.45 || summarySim ≥ 0.35 → rewritten   (reworded)
 *     titleSim < 0.45, different source    → original    (own reporting)
 *   label == "diff" (different events):
 *     → original (nothing to derive from; near-duplicates across
 *       different events are included on purpose as trap cases)
 *   Insufficient text (<3 title tokens) or cross-language full
 *   number-containment                     → unknown     (honest)
 *
 * Every entry keeps both URLs, timestamps, the label, a short rationale
 * and the similarity signals the label was based on.
 *
 * Run: npx tsx scripts/bench/gen-lineage-real.ts > bench/lineage-real.jsonl
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PairDoc {
  source: string;
  title: string;
  summary: string;
  url: string;
  language?: string;
  publishedAt: string;
}
interface Pair {
  id: string;
  a: PairDoc;
  b: PairDoc;
  label: "same" | "diff";
  trap?: string[];
}

const STOP = new Set(
  "the a an and or of to in on for with by at from as is are was were be been it its that this " +
    "và của cho các trong trên với từ theo là được đã có một những này đó khi tại về".split(
      " ",
    ),
);
const toks = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
const jac = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const t of a) if (b.has(t)) i++;
  return i / (a.size + b.size - i);
};
const shingles = (s: string) => {
  const t = toks(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3).join(" "));
  return out;
};
const YEAR = /^(19|20)\d{2}$/;
const nums = (s: string) =>
  new Set(
    (s.match(/\d[\d.,%]*/g) ?? [])
      .map((n) => n.replace(/[.,]/g, ""))
      .filter((n) => n.length >= 2 && !YEAR.test(n)),
  );

/** citation phrases a rewrite carries — used as label EVIDENCE, not the
 *  classifier's decision path */
const ATTR_RE =
  /(?:theo|dẫn|trích dẫn|hãng tin|according to|citing|per|quoting)\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ .]{1,30}?)(?:\s+(?:cho biết|đưa tin|cho hay|report|said|reported)|[,.])/i;

const file = fileURLToPath(
  new URL("../../bench/pairs.labeled.jsonl", import.meta.url),
);
const pairs: Pair[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const doc = (d: PairDoc, id: string) => ({
  documentId: id,
  source: d.source,
  title: d.title,
  summary: d.summary,
  publishedAt: d.publishedAt,
  url: d.url,
  language: d.language ?? "vi",
});

let n = 0;
const out: string[] = [];
const seen = new Set<string>();

// all same-event pairs + the most adversarial different-event pairs:
// near-identical wording across DIFFERENT events is exactly where a
// naive matcher over-claims syndication
const samePairs = pairs.filter((p) => p.label === "same");
const diffPairs = pairs
  .filter((p) => p.label === "diff")
  .map((p) => ({
    p,
    s: jac(new Set(toks(p.a.title)), new Set(toks(p.b.title))),
  }))
  .sort((x, y) => y.s - x.s)
  .slice(0, 70)
  .map((x) => x.p);

for (const p of [...samePairs, ...diffPairs]) {
  // child = the later-published article (derivation flows newer → older)
  const [first, second] =
    p.a.publishedAt <= p.b.publishedAt ? [p.a, p.b] : [p.b, p.a];
  const parentId = `${p.id.split("|")[0]}`;
  const childId = `${p.id.split("|")[1]}`;
  const key = `${childId}<-${parentId}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const titleSim = jac(new Set(toks(second.title)), new Set(toks(first.title)));
  const summarySim = jac(shingles(second.summary), shingles(first.summary));
  const cn = nums(second.title + " " + second.summary);
  const pn = nums(first.title + " " + first.summary);
  const contained = cn.size > 0 && [...cn].every((x) => pn.has(x));
  const langDiff = (second.language ?? "vi") !== (first.language ?? "vi");
  const attr = (second.title + ". " + second.summary).match(ATTR_RE);
  const citesParent =
    !!attr?.[1] &&
    first.source.toLowerCase().includes(attr[1].trim().toLowerCase());

  let label: string;
  let why: string;
  const conflict =
    cn.size > 0 && pn.size > 0 && ![...cn].some((x) => pn.has(x));
  if (p.label === "diff") {
    label = "original";
    why = "different event — nothing to derive from";
    if (titleSim >= 0.5)
      why = `trap: similar wording (titleSim=${titleSim.toFixed(2)}) but different event`;
  } else if (toks(second.title).length < 3) {
    label = "unknown";
    why = "insufficient text to evaluate";
  } else if (langDiff && contained) {
    label = "unknown";
    why =
      "cross-language, child's figures fully inside parent's — possible translation";
  } else if (conflict) {
    label = "unknown";
    why =
      "same event, zero shared figures — corrupted copy or independent report, can't tell";
  } else if (citesParent) {
    label = "quoted";
    why = `explicit citation "${attr![0].slice(0, 40)}"`;
  } else if (first.source === second.source && titleSim >= 0.45) {
    label = "rewritten";
    why = "same outlet follow-up/rewrite";
  } else if (titleSim >= 0.75) {
    label = "syndicated";
    why = `near-verbatim headline (titleSim=${titleSim.toFixed(2)})`;
  } else if (titleSim >= 0.45 || summarySim >= 0.35) {
    label = "rewritten";
    why = `reworded derivative (titleSim=${titleSim.toFixed(2)} sumSim=${summarySim.toFixed(2)})`;
  } else {
    label = "original";
    why = `same event, own wording (titleSim=${titleSim.toFixed(2)})`;
  }

  const entry = {
    id: `r${n++}`,
    label,
    note: `${second.source} vs ${first.source} — ${why}`,
    rationale: why,
    urls: { child: second.url, parent: first.url },
    signals: {
      titleSim: +titleSim.toFixed(3),
      summarySim: +summarySim.toFixed(3),
      sharedNumbers: [...cn].filter((x) => pn.has(x)).length,
      numbersContained: contained,
      languagePair: `${first.language ?? "vi"}->${second.language ?? "vi"}`,
      eventLabel: p.label,
    },
    child: doc(second, childId),
    candidates: [doc(first, parentId)],
  };
  out.push(JSON.stringify(entry));
}

// a few late-parent-shape cases: a doc evaluated with an empty pool
// stays 'unknown' until its true parent is observed — real docs, no
// candidate context
const loneDocs = new Map<string, PairDoc>();
for (const p of pairs) {
  loneDocs.set(p.id.split("|")[0], p.a);
  loneDocs.set(p.id.split("|")[1], p.b);
}
let lone = 0;
for (const [id, d] of loneDocs) {
  if (lone >= 8) break;
  lone++;
  out.push(
    JSON.stringify({
      id: `r${n++}`,
      label: "unknown",
      note: `${d.source} — observed alone, parent may be unobserved`,
      rationale: "no candidate coverage to evaluate against",
      urls: { child: d.url, parent: null },
      signals: { eventLabel: null, languagePair: d.language ?? "vi" },
      child: doc(d, id),
      candidates: [],
    }),
  );
}

process.stderr.write(
  `generated ${out.length} real lineage relationships ` +
    `(${pairs.filter((p) => p.label === "same").length} same-event, ` +
    `${pairs.filter((p) => p.label === "diff").length} different-event pairs scanned)\n`,
);
process.stdout.write(out.join("\n") + "\n");
