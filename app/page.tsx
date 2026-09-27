import type { Metadata } from "next";
import { cookies } from "next/headers";
import { dbEnabled } from "../lib/db/pool";
import {
  getGoldPremium,
  getLatestDataDeltas,
  getRadarBoard,
  getRecentEvents,
  type RadarSeriesRow,
} from "../lib/db/read";
import { buildRadarFeed, type RadarItem } from "../lib/radar";
import { emptyWatch, watchFromCookie } from "../lib/relevance";
import { canonicalEntity, extractEntities } from "../lib/entities";
import { timeAgo } from "../lib/model";
import SiteNav from "../components/SiteNav";
import RadarWatch from "../components/RadarWatch";
import SeenMarker from "../components/SeenMarker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ThunderFeed — Radar cá nhân" };

/** One morning screen answering: "since I last looked, what changed that
 *  I need to know, why does it matter to me, and where's the evidence?"
 *  Events, market deltas and macro deltas are all just RadarItems in one
 *  score-sorted feed — the board below is context, not the product. */

function fmt(v: string | number | null): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="macro-date">—</span>;
  const sign = v > 0 ? "+" : "";
  const cls = v > 0 ? "up" : v < 0 ? "down" : "";
  return (
    <span className={`macro-delta ${cls}`}>
      {sign}
      {v.toFixed(2)}%
    </span>
  );
}

/** The compact context strip — a handful of series a VN investor checks
 *  first, picked by instrument slug, not a 58-row dump. */
const STRIP_PICKS: { slug: string; label: string; provider?: string }[] = [
  { slug: "vang_sjc_9999", label: "SJC" },
  { slug: "xau_usd_spot", label: "XAU/USD" },
  { slug: "bitcoin", label: "BTC" },
  { slug: "ethereum", label: "ETH" },
  { slug: "usd_vnd", label: "USD/VND", provider: "vietcombank" },
  { slug: "usdt_vnd", label: "USDT P2P" },
  { slug: "vnindex", label: "VN-Index" },
];

function pickStrip(board: RadarSeriesRow[]): RadarSeriesRow[] {
  const out: RadarSeriesRow[] = [];
  for (const p of STRIP_PICKS) {
    const hit = board.find(
      (r) =>
        r.instrumentKey.includes(p.slug) &&
        (!p.provider || r.provider === p.provider),
    );
    if (hit) out.push(hit);
  }
  return out;
}

/** Frequency-ranked entity suggestions for the watch editor — the real
 *  entities currently moving through the feed, not a static taxonomy. */
function FeedItem({ i, nowMs }: { i: RadarItem; nowMs: number }) {
  return (
    <article className="radar-item">
      <div className="radar-item-head">
        <span className="macro-code">{i.badge}</span>
        <span className={`change-badge ${i.severity}`}>
          {i.severity === "high"
            ? "MẠNH"
            : i.severity === "medium"
              ? "VỪA"
              : "nhẹ"}
        </span>
        <span className="macro-date">{timeAgo(i.detectedAt, nowMs)}</span>
        {i.matched.length > 0 && (
          <span className="watch-matched">
            bạn theo dõi: {i.matched.join(" · ")}
          </span>
        )}
      </div>
      <a className="radar-item-title" href={i.href}>
        {i.title}
      </a>
      <div className="macro-units radar-item-ev">
        {i.evidence.join(" · ")}
        {i.related.length > 0 && " · tin có thể liên quan:"}
        {i.related.map((r) => (
          <span key={r.id}>
            {" "}
            <a href={`/event/${r.id}`}>{r.title}</a>;
          </span>
        ))}
      </div>
    </article>
  );
}

/** Umbrella types a watch chip shouldn't offer — following "vietnam"
 *  matches half the corpus, which is geo context, not a signal. */
const UMBRELLA_TYPES = new Set(["country", "region", "place", "topic"]);

function suggestedEntities(
  events: { title: string }[],
  watchEntities: string[],
  cap = 12,
): string[] {
  const freq = new Map<string, number>();
  for (const e of events)
    for (const slug of extractEntities(e.title))
      freq.set(slug, (freq.get(slug) ?? 0) + 1);
  return [...freq.entries()]
    .filter(
      ([s]) =>
        !watchEntities.includes(s) &&
        !UMBRELLA_TYPES.has(canonicalEntity(s)?.type ?? ""),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([s]) => s);
}

export default async function RadarPage() {
  const jar = await cookies();
  const watch = watchFromCookie(jar.get("tf_watch")?.value);
  /* "từ lần xem trước" is literal: tf_seen is written client-side AFTER
   * this render; until the first stamp lands, everything reads as new. */
  const prevSeenRaw = Number(jar.get("tf_seen")?.value);
  const prevSeenMs = Number.isFinite(prevSeenRaw) ? prevSeenRaw : null;
  const nowMs = Date.now();
  /* The homepage degrades to an empty radar rather than a 500 when the
   *  DB is unreachable — each lane fails independently. */
  const [board, premium, deltas, events] = dbEnabled()
    ? await Promise.all([
        getRadarBoard().catch(() => [] as RadarSeriesRow[]),
        getGoldPremium().catch(() => null),
        getLatestDataDeltas(40).catch(() => [] as never[]),
        getRecentEvents(250).catch(() => [] as never[]),
      ])
    : [[], null, [], []];
  const feed = buildRadarFeed(deltas, events, watch, nowMs, 24, prevSeenMs);
  /* two lanes, one promise: "từ lần xem trước" shows genuinely new items
   * (cap 7 — more is a digest, not a radar); "vẫn đáng chú ý" resurfaces
   * older items only while they're still material (score floor — age
   * alone doesn't earn the slot). */
  const STILL_MATERIAL_FLOOR = 45;
  const newItems = feed.filter((i) => i.isNew).slice(0, 7);
  const stillItems = feed
    .filter((i) => !i.isNew && i.score >= STILL_MATERIAL_FLOOR)
    .slice(0, 5);
  const strip = pickStrip(board);
  const suggested = suggestedEntities(events, watch.entities);
  const personalized = !emptyWatch(watch);

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">RADAR CÁ NHÂN</span>
          <SiteNav active="radar" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {feed.length} thay đổi đáng chú ý
          </span>
        </div>
      </header>

      <RadarWatch watch={watch} suggested={suggested} />
      <SeenMarker at={nowMs} />

      <section className="macro-group">
        <h2 className="macro-group-title">
          Từ lần xem trước
          <span className="macro-units">
            {newItems.length} thay đổi mới
            {personalized ? " · xếp theo radar của bạn" : " · chưa cá nhân hóa"}
          </span>
        </h2>
        {newItems.length === 0 ? (
          <p className="macro-units" style={{ padding: "0.6rem 0" }}>
            Không có gì mới kể từ lần xem trước — feed chỉ hiện thứ vượt ngưỡng
            điểm (impact × abnormality × relevance × freshness × evidence).
          </p>
        ) : (
          newItems.map((i) => (
            <FeedItem key={`${i.kind}-${i.id}`} i={i} nowMs={nowMs} />
          ))
        )}
      </section>

      {stillItems.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">
            Vẫn đáng chú ý
            <span className="macro-units">
              {stillItems.length} mục chưa hết relevance
            </span>
          </h2>
          {stillItems.map((i) => (
            <FeedItem key={`${i.kind}-${i.id}`} i={i} nowMs={nowMs} />
          ))}
        </section>
      )}

      {(strip.length > 0 || premium) && (
        <section className="macro-group">
          <h2 className="macro-group-title">
            Thị trường
            <span className="macro-units">
              <a href="/instrument">bảng đầy đủ →</a>
            </span>
          </h2>
          <table className="macro-table">
            <tbody>
              {premium && (
                <tr>
                  <td className="macro-name">
                    Premium SJC − TG
                    <span className="macro-vi">chênh lệch VND/lượng</span>
                  </td>
                  <td className="num macro-value">
                    {premium.premiumPct >= 0 ? "+" : ""}
                    {premium.premiumPct.toFixed(2)}%
                  </td>
                  <td className="num macro-units">
                    {fmt(Math.round(premium.spreadVnd))} ₫
                  </td>
                </tr>
              )}
              {strip.map((r) => (
                <tr key={r.seriesId}>
                  <td className="macro-name">
                    <a
                      href={`/instrument/${r.instrumentKey.split(":").join("/")}`}
                      className="macro-code"
                    >
                      {STRIP_PICKS.find((p) => r.instrumentKey.includes(p.slug))
                        ?.label ??
                        r.name ??
                        r.instrumentKey}
                    </a>
                  </td>
                  <td className="num macro-value">{fmt(r.close)}</td>
                  <td className="num">
                    <Pct v={r.dayChangePct} />
                  </td>
                  <td className="macro-units">
                    {r.provider}
                    {r.priceBasis === "quoted" ? " · quoted" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
