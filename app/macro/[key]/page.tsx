import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dbEnabled } from "../../../lib/db/pool";
import {
  getMacroPoints,
  getMacroRevisions,
  getMacroSeries,
} from "../../../lib/db/read";
import { entityHref } from "../../../lib/entities";
import SiteNav from "../../../components/SiteNav";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  return { title: `ThunderFeed — ${key}` };
}

/** Latest-vintage series as an SVG line — zero chart deps. */
function Sparkline({ points }: { points: { v: number; d: string }[] }) {
  const W = 720;
  const H = 220;
  const PAD = 8;
  if (points.length < 2) return null;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const xy = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((p.v - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <figure className="macro-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="series chart">
        <line
          x1={PAD}
          x2={W - PAD}
          y1={H - PAD}
          y2={H - PAD}
          className="macro-chart-axis"
        />
        <polyline points={xy.join(" ")} className="macro-chart-line" />
      </svg>
      <figcaption>
        <span>{points[0].d}</span>
        <span>
          {min.toLocaleString("en-US")} — {max.toLocaleString("en-US")}
        </span>
        <span>{points[points.length - 1].d}</span>
      </figcaption>
    </figure>
  );
}

export default async function MacroSeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ asOf?: string }>;
}) {
  const { key: rawKey } = await params;
  const { asOf } = await searchParams;
  // params arrive raw — ':' may be %3A-encoded depending on client
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    /* malformed escape — regex rejects it below */
  }
  if (!dbEnabled() || !/^[A-Za-z0-9_:.\-]{1,80}$/.test(key)) notFound();
  const series = await getMacroSeries(key);
  if (!series) notFound();

  const asOfOk = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : undefined;
  const [points, revisions] = await Promise.all([
    getMacroPoints(series.canonicalKey, {
      limit: 2000,
      order: "asc",
      asOf: asOfOk,
    }),
    getMacroRevisions(series.canonicalKey, 40),
  ]);
  const chart = points
    .map((p) => ({ v: Number(p.value), d: p.obsDate }))
    .filter((p) => Number.isFinite(p.v));
  const cur = points[points.length - 1];

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">VĨ MÔ</span>
          <SiteNav active="macro" />
        </div>
        <div className="masthead-right">
          <a className="edition-date" href="/macro">
            ← tất cả chỉ số
          </a>
        </div>
      </header>

      <section className="macro-detail">
        <h1 className="macro-detail-title">
          <span className="macro-code">{series.seriesCode}</span>
          {series.title ?? series.seriesCode}
        </h1>
        <p className="macro-detail-meta">
          {[series.units, series.frequency, series.seasonalAdjustment]
            .filter(Boolean)
            .join(" · ")}
          {series.entityKey && entityHref(series.entityKey) && (
            <>
              {" · "}
              <a
                className="macro-entity-link"
                href={entityHref(series.entityKey)!}
              >
                {series.entityKey}
              </a>
            </>
          )}
        </p>
        {cur && (
          <p className="macro-detail-latest">
            <b>{Number(cur.value).toLocaleString("en-US")}</b>
            <span>
              {" "}
              kỳ {cur.obsDate} · vintage {cur.vintageDate}
            </span>
          </p>
        )}
        <Sparkline points={chart} />
        {asOfOk && (
          <p className="macro-asof-note">
            Đang xem số liệu <b>như đã công bố tại {asOfOk}</b> — vintage view.
            <a href={`/macro/${series.seriesCode}`}> bỏ lọc →</a>
          </p>
        )}
        {!asOfOk && (
          <form className="macro-asof-form" method="get">
            <label>
              Xem số liệu như đã công bố ngày <input name="asOf" type="date" />
            </label>
            <button type="submit">Áp dụng</button>
          </form>
        )}
        {series.notes && <p className="macro-notes">{series.notes}</p>}
      </section>

      {revisions.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">
            Lịch sử revise ({revisions.length})
          </h2>
          <table className="macro-table">
            <thead>
              <tr>
                <th>Kỳ dữ liệu</th>
                <th className="num">Phiên bản</th>
                <th className="num">Giá trị đầu</th>
                <th className="num">Giá trị mới nhất</th>
                <th>Vintage đầu → cuối</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.obsDate}>
                  <td className="macro-date">{r.obsDate}</td>
                  <td className="num">{r.versions}</td>
                  <td className="num">{r.firstValue}</td>
                  <td className="num">{r.latestValue}</td>
                  <td className="macro-date">
                    {r.firstVintage} → {r.latestVintage}
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
