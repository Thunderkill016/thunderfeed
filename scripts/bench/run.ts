/**
 * ThunderFeed benchmark — replays human-labeled gold through the real
 * persistence path and scores the resolver, extractor, and dispute model.
 *
 *   npm run bench            pairs + claims + order-invariance
 *
 * Gates (fail → exit 1, only when the stratum has ≥5 samples):
 *   wrong-merge rate  < 1%     (resolver merges things it must not)
 *   split rate        < 5%     (resolver splits what is one event)
 *   cross-lang recall ≥ 85%    (same event across vi/en must merge)
 *   order-invariance  = 100%   (dispute state must not depend on order)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  BENCH_DIR,
  detectLang,
  docToCluster,
  readJsonl,
  setupBenchDb,
  type ClaimGold,
  type EventPair,
  type OrderCase,
} from "./shared";
import { persistCluster } from "../../lib/db/writer";
import { repHash, type PairFeatures } from "../../lib/resolver";
import { embedArticles } from "../../lib/embed";
import { extractClaims } from "../../lib/db/extract";

const MIN_STRATUM = 5;

/* --------------------------------- pairs ----------------------------------- */

/** semantic scorer for bench runs — disk-cached vectors first, live API
 *  only for misses (THUNDERFEED_BENCH_LIVE_EMBED=1 to enable) */
function benchEmbedder() {
  const file = `${BENCH_DIR}/results/semantic-vectors.json`;
  const cache = new Map<string, number[]>(
    existsSync(file)
      ? Object.entries(
          JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>,
        )
      : [],
  );
  const live = process.env.THUNDERFEED_BENCH_LIVE_EMBED === "1";
  const apiKey = process.env.GEMINI_API_KEY;
  return async (texts: string[]): Promise<(number[] | null)[]> => {
    const hashes = texts.map(repHash);
    const out: (number[] | null)[] = hashes.map((h) => cache.get(h) ?? null);
    const missIdx = hashes
      .map((h, i) => (out[i] ? -1 : i))
      .filter((i) => i >= 0);
    if (live && apiKey && missIdx.length) {
      const got = await embedArticles(
        apiKey,
        missIdx.map((i) => ({ id: hashes[i], text: texts[i] })),
      );
      for (const i of missIdx) {
        const v = got.get(hashes[i]);
        if (v) {
          out[i] = v;
          cache.set(hashes[i], v);
        }
      }
      writeFileSync(file, JSON.stringify(Object.fromEntries(cache)));
    }
    return out;
  };
}

async function runPairs(
  pairs: EventPair[],
  embedder?: ReturnType<typeof benchEmbedder>,
) {
  const labeled = pairs.filter((p) => p.label === "same" || p.label === "diff");
  const rows: {
    pair: EventPair;
    gold: "same" | "diff";
    pred: "same" | "diff";
    langPair: string;
    eval?: {
      decision: string;
      path: string;
      score: number;
      reasons: string[];
      hardBlocks: string[];
      features?: PairFeatures;
    };
  }[] = [];

  for (const p of labeled) {
    setupBenchDb(); // fresh event store per pair — isolation, no bleed
    const a = docToCluster(p.a);
    const b = docToCluster(p.b);
    const ra = await persistCluster(a, extractClaims(a), { embedder });
    const rb = await persistCluster(b, extractClaims(b), { embedder });
    const langPair = [
      p.a.language ?? detectLang(p.a.title),
      p.b.language ?? detectLang(p.b.title),
    ]
      .sort()
      .join("-");
    // the evaluation of B against A's event — the decision that matters
    const ev = (rb.resolverEvals ?? []).find(
      (e) => e.candidateId === ra.eventId,
    );
    rows.push({
      pair: p,
      gold: p.label as "same" | "diff",
      pred: ra.eventId === rb.eventId ? "same" : "diff",
      langPair,
      eval: ev
        ? {
            decision: ev.decision.decision,
            path: ev.decision.path,
            score: ev.decision.score,
            reasons: ev.decision.reasons,
            hardBlocks: ev.decision.hardBlocks,
            features: ev.decision.features,
          }
        : undefined,
    });
  }
  return rows;
}

/** failure-class taxonomy for split misses (Phase 0) */
function classifySplit(r: {
  langPair: string;
  eval?: {
    path?: string;
    features?: {
      lexicalSimilarity?: number;
      sharedCoreEntities?: string[];
      nonHubSharedCore?: string[];
      sharedEntities?: string[];
      numberConflict?: boolean;
      distinctiveClaimOverlap?: number;
      genericClaimOverlap?: number;
      sharedRareTokens?: string[];
      sharedBigrams?: string[];
    };
  };
}): string {
  const f = r.eval?.features;
  if (!f) return "other";
  if (r.langPair === "en-vi") return "cross-language paraphrase";
  if (f.numberConflict) return "same event / changing numeric facts";
  if ((f.nonHubSharedCore?.length ?? 0) > 0)
    return "same actor but lexical drift";
  if ((f.sharedCoreEntities?.length ?? 0) > 0)
    return "same event / different location wording";
  if ((f.sharedEntities?.length ?? 0) === 0) return "missing entity alias";
  if (
    (f.distinctiveClaimOverlap ?? 0) === 0 &&
    (f.genericClaimOverlap ?? 0) === 0
  )
    return "no deterministic claim extracted";
  if ((f.lexicalSimilarity ?? 0) >= 0.3) return "headline drift";
  return "other";
}

/** Phase 0 — machine-readable export of every pair decision. */
function exportBaseline(
  rows: Awaited<ReturnType<typeof runPairs>>,
  file: string,
) {
  const out = rows.map((r) => ({
    id: r.pair.id,
    gold: r.gold,
    prediction: r.pred,
    langPair: r.langPair,
    trap: r.pair.trap ?? [],
    titleA: r.pair.a.title,
    titleB: r.pair.b.title,
    publishedA: r.pair.a.publishedAt ?? null,
    publishedB: r.pair.b.publishedAt ?? null,
    timeDeltaHours:
      r.pair.a.publishedAt && r.pair.b.publishedAt
        ? Math.abs(
            Date.parse(r.pair.a.publishedAt) - Date.parse(r.pair.b.publishedAt),
          ) / 3_600_000
        : null,
    decision: r.eval ?? null,
    failureClass:
      r.gold === "same" && r.pred === "diff" ? classifySplit(r) : null,
  }));
  mkdirSync(`${BENCH_DIR}/results`, { recursive: true });
  writeFileSync(`${BENCH_DIR}/results/${file}`, JSON.stringify(out, null, 1));
  const taxonomy = new Map<string, number>();
  for (const r of out) {
    if (r.failureClass)
      taxonomy.set(r.failureClass, (taxonomy.get(r.failureClass) ?? 0) + 1);
  }
  if (taxonomy.size) {
    console.log(`  ── split taxonomy (${file}):`);
    for (const [k, n] of [...taxonomy.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`    ${k.padEnd(42)} ${n}`);
  }
}

interface Stratum {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

const empty = (): Stratum => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
const bump = (s: Stratum, gold: string, pred: string) => {
  if (gold === "same" && pred === "same") s.tp++;
  else if (gold === "same") s.fn++;
  else if (pred === "same") s.fp++;
  else s.tn++;
};
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : "—");

function reportPairs(rows: Awaited<ReturnType<typeof runPairs>>) {
  const all = empty();
  const byLang = new Map<string, Stratum>();
  const byTrap = new Map<string, Stratum>();
  const fails: typeof rows = [];

  for (const r of rows) {
    bump(all, r.gold, r.pred);
    const l = byLang.get(r.langPair) ?? empty();
    bump(l, r.gold, r.pred);
    byLang.set(r.langPair, l);
    for (const t of r.pair.trap ?? []) {
      const s = byTrap.get(t) ?? empty();
      bump(s, r.gold, r.pred);
      byTrap.set(t, s);
    }
    if (r.gold !== r.pred) fails.push(r);
  }

  const p = pct(all.tp, all.tp + all.fp);
  const r = pct(all.tp, all.tp + all.fn);
  const f1 =
    all.tp + all.fp > 0 && all.tp + all.fn > 0
      ? (((2 * all.tp) / (2 * all.tp + all.fp + all.fn)) * 100).toFixed(1)
      : "—";
  const wrongMerge = pct(all.fp, all.fp + all.tn);
  const split = pct(all.fn, all.fn + all.tp);

  console.log(`\n══ EVENT RESOLVER — ${rows.length} labeled pairs`);
  console.log(
    `  merge P=${p}% R=${r}% F1=${f1}%  ·  wrong-merge=${wrongMerge}%  split=${split}%`,
  );
  for (const [k, s] of [...byLang.entries()].sort())
    console.log(
      `    ${k.padEnd(8)} n=${String(s.tp + s.fp + s.fn + s.tn).padStart(3)}  ` +
        `wrong-merge=${pct(s.fp, s.fp + s.tn)}%  split=${pct(s.fn, s.fn + s.tp)}%`,
    );
  for (const [k, s] of [...byTrap.entries()].sort())
    console.log(
      `    ${k.padEnd(22)} n=${String(s.tp + s.fp + s.fn + s.tn).padStart(3)}  ` +
        `wrong-merge=${pct(s.fp, s.fp + s.tn)}%  split=${pct(s.fn, s.fn + s.tp)}%`,
    );
  if (fails.length) {
    console.log(`  ── misses:`);
    for (const f of fails.slice(0, 12))
      console.log(
        `    ${f.gold}→${f.pred}  [${f.pair.trap?.join(",")}] ` +
          `${f.pair.a.title.slice(0, 50)} ⇄ ${f.pair.b.title.slice(0, 50)}`,
      );
  }

  const gate = { fail: false };
  const check = (name: string, ok: boolean, n: number) => {
    if (n < MIN_STRATUM) {
      console.log(`    · ${name}: skipped (n=${n})`);
      return;
    }
    console.log(`    ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) gate.fail = true;
  };
  console.log(`  ── gates:`);
  const xRows = rows.filter((r) => r.langPair === "en-vi");
  const xs = empty();
  for (const r of xRows) bump(xs, r.gold, r.pred);
  check(
    `wrong-merge < 1% (${all.fp}/${all.fp + all.tn})`,
    all.fp / Math.max(1, all.fp + all.tn) < 0.01,
    all.fp + all.tn,
  );
  check(
    `split < 5% (${all.fn}/${all.fn + all.tp})`,
    all.fn / Math.max(1, all.fn + all.tp) < 0.05,
    all.fn + all.tp,
  );
  check(
    `cross-lang recall ≥ 85% (${xs.tp}/${xs.tp + xs.fn})`,
    xs.tp / Math.max(1, xs.tp + xs.fn) >= 0.85,
    xs.tp + xs.fn,
  );
  return gate.fail;
}

/* --------------------------------- claims ---------------------------------- */

const normVal = (v: unknown) =>
  typeof v === "object" && v !== null
    ? JSON.stringify(v)
    : String(v).replace(/,/g, "");

async function runClaims(gold: ClaimGold[]) {
  let tp = 0,
    fp = 0,
    fn = 0;
  const misses: string[] = [];
  for (const g of gold) {
    const c = docToCluster(g.article);
    const got = extractClaims(c);
    const want = g.claims.map((x) => `${x.predicate}=${normVal(x.value)}`);
    const have = got.map((x) => `${x.predicate}=${normVal(x.value)}`);
    const unmatched = new Set(want);
    for (const h of have)
      if (unmatched.delete(h)) tp++;
      else fp++;
    for (const w of unmatched) {
      fn++;
      misses.push(`    MISS ${w}  — "${g.article.title.slice(0, 60)}"`);
    }
    for (const h of have)
      if (!want.includes(h))
        misses.push(`    EXTRA ${h} — "${g.article.title.slice(0, 60)}"`);
  }
  console.log(`\n══ CLAIM EXTRACTION — ${gold.length} articles`);
  console.log(
    `  P=${pct(tp, tp + fp)}%  R=${pct(tp, tp + fn)}%  ` +
      `F1=${tp + fp + fn ? (((2 * tp) / (2 * tp + fp + fn)) * 100).toFixed(1) : "—"}%  ` +
      `(tp=${tp} fp=${fp} fn=${fn})`,
  );
  for (const m of misses.slice(0, 15)) console.log(m);
  return { tp, fp, fn };
}

/* ----------------------------- order-invariance ---------------------------- */

function permutations<T>(arr: T[], cap = 24): T[][] {
  const out: T[][] = [];
  const rec = (cur: T[], rest: T[]) => {
    if (out.length >= cap) return;
    if (!rest.length) return out.push(cur);
    for (let i = 0; i < rest.length; i++)
      rec(
        [...cur, rest[i]],
        rest.filter((_, j) => j !== i),
      );
  };
  rec([], arr);
  return out;
}

async function runOrder(cases_: OrderCase[]) {
  let bad = 0;
  for (const oc of cases_) {
    const perms = permutations(oc.assertions);
    const signatures = new Map<string, number>();
    for (const perm of perms) {
      const pool = setupBenchDb();
      let eventId = "";
      for (const a of perm) {
        const c = docToCluster({
          source: a.source,
          title: a.title,
          language: "vi",
          topic: "world",
          publishedAt: a.publishedAt,
        });
        const r = await persistCluster(
          c,
          [
            {
              claimKey: oc.claim.claimKey,
              predicate: oc.claim.predicate,
              claimType: "fact",
              valueType: "number",
              value: a.value,
              label: oc.claim.label,
              assertedBy: a.source,
              assertedAt: a.publishedAt,
              method: "rule",
            },
          ],
          a.primary
            ? { sourceMeta: { [a.source]: { kind: "primary" } } }
            : undefined,
        );
        eventId = r.eventId;
      }
      // final state signature: claim state + position→sources multiset
      const { rows } = await pool.query<{
        state: string;
        value: string;
      }>(
        `SELECT cv.state, cv.value::text AS value
         FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
         WHERE c.event_id = $1`,
        [eventId],
      );
      // live positions = the value of each source's LATEST asserted version
      // (pg-mem lacks window functions — reduce in JS)
      const { rows: posRows } = await pool.query<{
        v: string;
        s: string;
      }>(
        `SELECT cv.value::text AS v, s.name AS s
         FROM claim_evidence ce
         JOIN claim_versions cv ON cv.id = ce.claim_version_id
         JOIN claims c ON c.id = cv.claim_id
         JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
         JOIN evidence_documents d ON d.id = ev.document_id
         JOIN sources s ON s.id = d.source_id
         WHERE c.event_id = $1
         ORDER BY s.name,
                  COALESCE(d.published_at, ev.observed_at) DESC`,
        [eventId],
      );
      const latestBySrc = new Map<string, string>();
      for (const r of posRows)
        if (!latestBySrc.has(r.s)) latestBySrc.set(r.s, r.v);
      const pos = [...latestBySrc.entries()]
        .map(([s, v]) => ({ v, s }))
        .sort((x, y) => x.v.localeCompare(y.v) || x.s.localeCompare(y.s));
      const sig = JSON.stringify({
        st: rows.map((r) => [r.state, r.value]),
        // latest vote per source determines its live position
        pos: pos.map((r) => [r.v, r.s]),
      });
      signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
    }
    const ok = signatures.size === 1;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${oc.id}: ${perms.length} orders → ${signatures.size} distinct outcomes`,
    );
  }
  return bad > 0;
}

/* ---------------------------------- main ------------------------------------ */

async function main() {
  const pairs = readJsonl<EventPair>("pairs.jsonl");
  const claims = readJsonl<ClaimGold>("claims.jsonl");
  const orders = readJsonl<OrderCase>("order.jsonl");
  console.log(
    `bench: ${pairs.length} pairs · ${claims.length} claim articles · ${orders.length} order cases`,
  );

  let fail = false;
  if (pairs.length) {
    const embedder =
      process.env.THUNDERFEED_BENCH_NO_EMBED === "1"
        ? undefined
        : benchEmbedder();
    const rows = await runPairs(pairs, embedder);
    exportBaseline(rows, "resolver-baseline.json");
    fail = (await reportPairs(rows)) || fail;
  }
  if (claims.length) await runClaims(claims);
  if (orders.length) {
    console.log(`\n══ ORDER-INVARIANCE — dispute must not depend on order`);
    fail = (await runOrder(orders)) || fail;
  }
  console.log(fail ? "\nBENCH: FAIL" : "\nBENCH: PASS");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
