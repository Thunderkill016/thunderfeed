/* R7.0 — Materiality Quality Lab corpus dump.
 *
 *   DATABASE_URL=... npx tsx scripts/materiality/dump-corpus.mts [--events N] [--out path]
 *
 * Freezes a mixed candidate set — news events + macro deltas +
 * corporate actions + market moves — with each item's deterministic
 * baseline assessment attached (lib/materiality.ts). Labels start NULL;
 * the benchmark only reads items whose `labels` were filled in later.
 * The corpus is a fixture — re-dump only deliberately, never in CI. */
import { writeFileSync } from "node:fs";
import { getPool } from "../../lib/db/pool.ts";
import {
  scoreCorporateAction,
  scoreEventMateriality,
  scoreMacroDelta,
  scoreMarketMove,
} from "../../lib/materiality.ts";

const args = process.argv.slice(2);
const evIdx = args.indexOf("--events");
const N_EVENTS = evIdx >= 0 ? Number(args[evIdx + 1]) : 150;
const N_MACRO = 80;
const N_CA = 40;
const N_MOVES = 30;
const outIdx = args.indexOf("--out");
const OUT =
  outIdx >= 0 ? args[outIdx + 1] : "tests/fixtures/materiality-corpus.json";

const db = getPool();
type Item = Record<string, unknown>;
const items: Item[] = [];

/* ── news events ────────────────────────────────────────────── */
{
  const { rows: events } = await db.query<{
    id: string;
    title: string;
    topic: string;
    last_seen_at: string;
  }>(
    `SELECT e.id, ev.title, e.topic, e.last_seen_at
       FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
      WHERE e.status NOT IN ('merged','archived')
      ORDER BY e.last_seen_at DESC
      LIMIT $1`,
    [N_EVENTS],
  );
  const ids = events.map((e) => e.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");

  const { rows: preds } = ids.length
    ? await db.query<{ event_id: string; predicate: string }>(
        `SELECT DISTINCT event_id, predicate FROM claims
          WHERE event_id IN (${ph})`,
        ids,
      )
    : { rows: [] };
  const { rows: ents } = ids.length
    ? await db.query<{
        event_id: string;
        entity_type: string;
        slug: string;
      }>(
        `SELECT DISTINCT ee.event_id, e.entity_type, ee.entity_slug AS slug
           FROM event_entities ee JOIN entities e ON e.id = ee.entity_id
          WHERE ee.event_id IN (${ph})`,
        ids,
      )
    : { rows: [] };
  const { rows: states } = ids.length
    ? await db.query<{ event_id: string; state: string; n: string }>(
        `SELECT c.event_id, cv.state, count(*)::text AS n
           FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
          WHERE c.event_id IN (${ph}) GROUP BY 1, 2`,
        ids,
      )
    : { rows: [] };

  const byEv = <T extends { event_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      if (!m.has(r.event_id)) m.set(r.event_id, []);
      m.get(r.event_id)!.push(r);
    }
    return m;
  };
  const predByEv = byEv(preds);
  const entByEv = byEv(ents);
  const stByEv = byEv(states);

  for (const e of events) {
    const subject = {
      topic: e.topic,
      predicates: (predByEv.get(e.id) ?? []).map((p) => p.predicate),
      entityTypes: [
        ...new Set((entByEv.get(e.id) ?? []).map((x) => x.entity_type)),
      ],
      entitySlugs: (entByEv.get(e.id) ?? []).map((x) => x.slug),
      claimStates: Object.fromEntries(
        (stByEv.get(e.id) ?? []).map((s) => [s.state, Number(s.n)]),
      ),
      lastSeenAt: e.last_seen_at,
    };
    items.push({
      kind: "event",
      id: e.id,
      title: e.title,
      subject,
      baseline: scoreEventMateriality({
        predicates: subject.predicates as string[],
        entityTypes: subject.entityTypes as string[],
        entitySlugs: subject.entitySlugs as string[],
        topic: e.topic,
      }),
      labels: null,
    });
  }
}

/* ── macro deltas ───────────────────────────────────────────── */
{
  const { rows: deltas } = await db.query<{
    id: string;
    kind: string;
    summary: string;
    detected_at: string;
    series_code: string;
    provider: string;
    frequency: string | null;
    title: string;
    value: string;
    prev: string | null;
    series_id: string;
  }>(
    `SELECT dd.id, dd.kind, dd.summary, dd.detected_at,
            ms.series_code, ms.provider, ms.frequency, ms.title,
            mpv.value::text AS value,
            ppv.value::text AS prev,
            ms.id AS series_id
       FROM data_deltas dd
       JOIN macro_point_versions mpv ON mpv.id = dd.macro_version_id
       JOIN macro_points mp ON mp.id = mpv.point_id
       JOIN macro_series ms ON ms.id = mp.series_id
       LEFT JOIN macro_point_versions ppv ON ppv.id = dd.prev_macro_version_id
      WHERE dd.kind IN ('macro_release','macro_revision')
      ORDER BY dd.detected_at DESC
      LIMIT 2000`,
  );
  /* stratify by provider — recency order alone returns only the last bulk
   * import (all IMF/WB annual); FRED high-frequency prints must be in the
   * corpus for the lab to cover both regimes */
  {
    const fred = deltas.filter((d) => d.provider === "fred");
    const other = deltas.filter((d) => d.provider !== "fred");
    const nFred = Math.min(fred.length, Math.ceil(N_MACRO * 0.6));
    /* round-robin the annual providers so a bulk IMF import can't crowd
     * out World Bank entirely */
    const buckets = ["imf", "worldbank"].map((p) =>
      other.filter((d) => d.provider === p),
    );
    const annual: typeof other = [];
    while (annual.length < N_MACRO - nFred) {
      let added = false;
      for (const b of buckets)
        if (b.length) {
          annual.push(b.shift()!);
          added = true;
        }
      if (!added) break;
    }
    deltas.length = 0;
    deltas.push(...fred.slice(0, nFred), ...annual);
  }
  /* trailing history per series for the abnormality baseline */
  const seriesIds = [...new Set(deltas.map((d) => d.series_id))];
  const histBySeries = new Map<string, number[]>();
  for (const sid of seriesIds) {
    const { rows } = await db.query<{ v: string }>(
      `SELECT mpv.value::text AS v
         FROM macro_points mp
         JOIN macro_point_versions mpv ON mpv.id = mp.current_version_id
        WHERE mp.series_id = $1
        ORDER BY mp.obs_date DESC LIMIT 40`,
      [sid],
    );
    histBySeries.set(sid, rows.map((r) => Number(r.v)).reverse());
  }
  for (const d of deltas) {
    const history = (histBySeries.get(d.series_id) ?? []).filter((v) =>
      Number.isFinite(v),
    );
    items.push({
      kind: d.kind,
      id: d.id,
      title: `${d.series_code} — ${d.title}`,
      subject: {
        provider: d.provider,
        seriesCode: d.series_code,
        frequency: d.frequency,
        value: Number(d.value),
        prevValue: d.prev == null ? null : Number(d.prev),
        /* trailing observations needed to re-score abnormality offline */
        history: history.slice(0, -1),
        detectedAt: d.detected_at,
        summary: d.summary,
      },
      baseline: scoreMacroDelta({
        provider: d.provider,
        seriesCode: d.series_code,
        frequency: d.frequency,
        kind: d.kind as "macro_release" | "macro_revision",
        value: Number(d.value),
        prevValue: d.prev == null ? null : Number(d.prev),
        history: history.slice(0, -1), // exclude the released value itself
      }),
      labels: null,
    });
  }
}

/* ── corporate actions ──────────────────────────────────────── */
{
  const { rows: cas } = await db.query<{
    id: string;
    canonical_key: string;
    action_type: string;
    ex_date: string | null;
    cash_amount: string | null;
    currency: string | null;
    split_factor: string | null;
    name: string;
    ticker: string | null;
    venue: string | null;
    close: string | null;
  }>(
    `SELECT ca.id, ca.canonical_key, ca.action_type,
            cav.ex_date, cav.cash_amount::text, cav.currency,
            cav.split_factor::text,
            iv.name, lv.ticker, tv.acronym AS venue,
            mpv.close::text
       FROM corporate_actions ca
       JOIN corporate_action_versions cav ON cav.id = ca.current_version_id
       JOIN financial_instruments fi ON fi.id = ca.instrument_id
       JOIN instrument_versions iv ON iv.id = fi.current_version_id
       LEFT JOIN instrument_listings il ON il.instrument_id = fi.id
       LEFT JOIN listing_versions lv ON lv.id = il.current_version_id
       LEFT JOIN trading_venues t ON t.id = il.venue_id
       LEFT JOIN trading_venue_versions tv ON tv.id = t.current_version_id
       LEFT JOIN LATERAL (
         SELECT mpv2.close FROM market_series ms
           JOIN market_points mp2 ON mp2.series_id = ms.id
           JOIN market_point_versions mpv2 ON mpv2.id = mp2.current_version_id
          WHERE ms.listing_id = il.id
          ORDER BY mp2.session_date DESC LIMIT 1
       ) mpv ON true
      ORDER BY cav.ex_date DESC NULLS LAST
      LIMIT 2000`,
  );
  /* diversify — prod CA coverage is US-only (AAPL dominates), so cap per
   * ticker+action; keep all splits for the type's special-casing */
  {
    const counts = new Map<string, number>();
    const keep: typeof cas = [];
    for (const c of cas) {
      const sig = `${c.ticker ?? c.name}:${c.action_type}`;
      const n = counts.get(sig) ?? 0;
      if (c.action_type !== "stock_split" && n >= 3) continue;
      counts.set(sig, n + 1);
      keep.push(c);
    }
    cas.length = 0;
    cas.push(...keep.slice(0, N_CA));
  }
  for (const c of cas) {
    const key = `equity:${c.venue ?? "?"}:${c.ticker ?? c.name}`;
    items.push({
      kind: "corporate_action",
      id: c.id,
      title: `${c.ticker ?? c.name} — ${c.action_type}`,
      subject: {
        actionType: c.action_type,
        instrumentKey: key,
        cashAmount: c.cash_amount == null ? null : Number(c.cash_amount),
        currency: c.currency,
        splitFactor: c.split_factor == null ? null : Number(c.split_factor),
        exDate: c.ex_date,
        referencePrice: c.close == null ? null : Number(c.close),
      },
      baseline: scoreCorporateAction({
        actionType: c.action_type as "cash_dividend" | "stock_split",
        instrumentKey: key,
        cashAmount: c.cash_amount == null ? null : Number(c.cash_amount),
        currency: c.currency,
        referencePrice: c.close == null ? null : Number(c.close),
        splitFactor: c.split_factor == null ? null : Number(c.split_factor),
      }),
      labels: null,
    });
  }
}

/* ── market moves — derived from market_points (no deltas exist) ── */
{
  const { rows: series } = await db.query<{
    series_id: string;
    name: string;
    asset_class: string;
    ticker: string | null;
    venue: string | null;
  }>(
    `SELECT ms.id AS series_id, iv.name, iv.asset_class,
            lv.ticker, tv.acronym AS venue
       FROM market_series ms
       JOIN instrument_listings il ON il.id = ms.listing_id
       JOIN financial_instruments fi ON fi.id = il.instrument_id
       JOIN instrument_versions iv ON iv.id = fi.current_version_id
       LEFT JOIN listing_versions lv ON lv.id = il.current_version_id
       LEFT JOIN trading_venues t ON t.id = il.venue_id
       LEFT JOIN trading_venue_versions tv ON tv.id = t.current_version_id
      WHERE ms.status = 'active'`,
  );
  const moves: {
    seriesId: string;
    name: string;
    key: string;
    assetClass: string;
    isIndex: boolean;
    date: string;
    pct: number;
    z: number | null;
  }[] = [];
  for (const s of series) {
    const { rows: pts } = await db.query<{ d: string; c: string }>(
      `SELECT mp.session_date::text AS d, mpv.close::text AS c
         FROM market_points mp
         JOIN market_point_versions mpv ON mpv.id = mp.current_version_id
        WHERE mp.series_id = $1
        ORDER BY mp.session_date DESC LIMIT 60`,
      [s.series_id],
    );
    if (pts.length < 10) continue;
    const asc = pts.reverse().map((p) => ({
      date: p.d.slice(0, 10),
      close: Number(p.c),
    }));
    const rets: number[] = [];
    for (let k = 1; k < asc.length; k++)
      rets.push(((asc[k].close - asc[k - 1].close) / asc[k - 1].close) * 100);
    if (rets.length < 8) continue;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(
      rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1),
    );
    const last = rets[rets.length - 1];
    const key = `${s.asset_class}:${s.venue ?? "?"}:${s.ticker ?? s.name}`;
    moves.push({
      seriesId: s.series_id,
      name: s.name,
      key,
      assetClass: s.asset_class,
      isIndex: s.asset_class === "index" || s.name.includes("Index"),
      date: asc[asc.length - 1].date,
      pct: last,
      z: sd > 0 ? last / sd : null,
    });
  }
  /* dedupe by instrument key — the same listing can have parallel
   * provider series (alphavantage/tiingo) reporting the identical move */
  {
    const byKey = new Map<string, (typeof moves)[number]>();
    for (const m of moves) {
      const cur = byKey.get(m.key);
      if (!cur || Math.abs(m.z ?? 0) > Math.abs(cur.z ?? 0))
        byKey.set(m.key, m);
    }
    moves.length = 0;
    moves.push(...byKey.values());
  }
  /* top movers by |z| + a normal-day sample — both signs needed so the
   * lab can tell "big move" from "routine" */
  moves.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
  const picked = [
    ...moves.slice(0, Math.ceil(N_MOVES * 0.7)),
    ...moves.slice(-Math.floor(N_MOVES * 0.3)),
  ];
  for (const m of picked) {
    items.push({
      kind: "market_move",
      id: `${m.seriesId}:${m.date}`,
      title: `${m.name} ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(2)}% (${m.date})`,
      subject: {
        instrumentKey: m.key,
        assetClass: m.assetClass,
        pctChange: m.pct,
        z: m.z,
        sessionDate: m.date,
      },
      baseline: scoreMarketMove({
        instrumentKey: m.key,
        assetClass: (m.assetClass === "index" ? "index" : m.assetClass) as
          "equity" | "commodity" | "crypto" | "fx" | "index",
        pctChange: m.pct,
        trailingVol: m.z != null ? Math.abs(m.pct / m.z) : null,
        isIndex: m.isIndex,
      }),
      labels: null,
    });
  }
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      dumpedAt: new Date().toISOString(),
      rubric: "docs/materiality-rubric.md",
      items,
    },
    null,
    2,
  ),
);
const byKind = new Map<string, number>();
for (const i of items)
  byKind.set(i.kind as string, (byKind.get(i.kind as string) ?? 0) + 1);
console.log(`wrote ${items.length} items → ${OUT}`);
for (const [k, n] of byKind) console.log(`  ${k}: ${n}`);
await db.end();
