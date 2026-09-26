import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dbEnabled } from "../../../lib/db/pool";
import {
  getCorporateActionsForInstrument,
  getDailyBarsForSeries,
  getInstrumentView,
  getMarketSeriesForListing,
} from "../../../lib/db/read";
import { entityHref } from "../../../lib/entities";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string[] }>;
}): Promise<Metadata> {
  const { key } = await params;
  return { title: `ThunderFeed — ${key.join("/")}` };
}

const TYPE_VI: Record<string, string> = {
  common_stock: "cổ phiếu phổ thông",
  preferred_stock: "cổ phiếu ưu đãi",
  etf: "ETF",
  adr: "ADR",
};
const ACTION_VI: Record<string, string> = {
  cash_dividend: "Cổ tức tiền mặt",
  split: "Chia tách",
  spinoff: "Tách",
  merger: "Sáp nhập",
};
const AGREEMENT_VI: Record<string, string> = {
  agreement: "2 nguồn đồng thuận",
  divergence: "2 nguồn khác nhau",
  single_source: "1 nguồn",
};

function Bars({ pts }: { pts: { v: number; d: string }[] }) {
  const W = 720;
  const H = 200;
  const PAD = 8;
  if (pts.length < 2) return null;
  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const xy = pts.map(
    (p, i) =>
      `${(PAD + (i / (pts.length - 1)) * (W - PAD * 2)).toFixed(1)},${(
        H -
        PAD -
        ((p.v - min) / span) * (H - PAD * 2)
      ).toFixed(1)}`,
  );
  return (
    <figure className="macro-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="price chart">
        <polyline points={xy.join(" ")} className="macro-chart-line" />
      </svg>
      <figcaption>
        <span>{pts[0].d}</span>
        <span>
          {min.toLocaleString("en-US")} — {max.toLocaleString("en-US")}
        </span>
        <span>{pts[pts.length - 1].d}</span>
      </figcaption>
    </figure>
  );
}

export default async function InstrumentPage({
  params,
}: {
  params: Promise<{ key: string[] }>;
}) {
  const { key } = await params;
  const canonicalKey = key.join(":");
  if (!dbEnabled() || !/^instrument:[a-z0-9_:]{1,120}$/.test(canonicalKey))
    notFound();
  const view = await getInstrumentView(canonicalKey);
  if (!view) notFound();
  const ins = view.instrument;

  const listingCards = await Promise.all(
    view.listings.map(async (l) => {
      const series = await getMarketSeriesForListing(l.id);
      // as-traded wins for the headline chart; adjusted is a basis switch
      const chosen =
        series.find(
          (s) => s.priceBasis === "as_traded" && s.provider === "tiingo",
        ) ??
        series.find((s) => s.priceBasis === "as_traded") ??
        series[0] ??
        null;
      const bars = chosen
        ? await getDailyBarsForSeries(chosen.id, {
            limit: 400,
            order: "asc",
          })
        : [];
      return { l, series, chosen, bars };
    }),
  );
  const actions = await getCorporateActionsForInstrument(ins.id);

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">CHỨNG KHOÁN</span>
        </div>
        <div className="masthead-right">
          <span className="edition-date">{ins.canonicalKey}</span>
        </div>
      </header>

      <section className="macro-detail">
        <h1 className="macro-detail-title">
          {ins.name ?? ins.shortName ?? ins.canonicalKey}
        </h1>
        <p className="macro-detail-meta">
          {TYPE_VI[ins.type] ?? ins.type}
          {ins.currency && ` · ${ins.currency}`}
          {view.issuer && entityHref(view.issuer.canonicalKey) && (
            <>
              {" · phát hành bởi "}
              <a
                className="macro-entity-link"
                href={entityHref(view.issuer.canonicalKey)!}
              >
                {view.issuer.name ?? view.issuer.canonicalKey}
              </a>
            </>
          )}
        </p>
      </section>

      {listingCards.map(({ l, series, chosen, bars }) => (
        <section key={l.id} className="macro-group">
          <h2 className="macro-group-title">
            {l.ticker ?? l.canonicalKey}
            {l.venue?.name ? ` — ${l.venue.name}` : ""}
          </h2>
          {l.latestMarket && (
            <p className="macro-detail-latest">
              <b>{Number(l.latestMarket.close).toLocaleString("en-US")}</b>
              <span>
                {" "}
                {l.latestMarket.currency ?? ""} · {l.latestMarket.sessionDate} ·{" "}
                {l.latestMarket.provider}
              </span>
            </p>
          )}
          {chosen && (
            <p className="macro-detail-meta">
              series: {chosen.provider}/{chosen.dataset} · basis{" "}
              {chosen.priceBasis} · {bars.length} phiên
              {series.length > 1 &&
                ` (+${series.length - 1} series khác: ${series
                  .filter((s) => s.id !== chosen.id)
                  .map((s) => `${s.provider}/${s.priceBasis}`)
                  .join(", ")})`}
            </p>
          )}
          <Bars
            pts={bars.map((b) => ({ v: Number(b.close), d: b.sessionDate }))}
          />
        </section>
      ))}

      {actions.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">
            Corporate actions ({actions.length})
          </h2>
          <table className="macro-table">
            <thead>
              <tr>
                <th>Loại</th>
                <th>Ex-date</th>
                <th className="num">Giá trị</th>
                <th>Payment</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                const v = a.currentVersion;
                const value =
                  v?.cashAmount != null
                    ? `${v.cashAmount} ${v.currency ?? ""}`.trim()
                    : v?.splitFactor != null
                      ? `${v.splitFrom}:${v.splitTo}`
                      : "—";
                return (
                  <tr key={a.id}>
                    <td>{ACTION_VI[a.actionType] ?? a.actionType}</td>
                    <td className="macro-date">{v?.exDate ?? "—"}</td>
                    <td className="num">{value}</td>
                    <td className="macro-date">{v?.paymentDate ?? "—"}</td>
                    <td>
                      <span
                        className={`ca-agree ${a.agreement.state}`}
                        title={
                          a.agreement.divergentFields.length
                            ? `khác nhau: ${a.agreement.divergentFields.join(", ")}`
                            : a.agreement.providers.join(" + ")
                        }
                      >
                        {AGREEMENT_VI[a.agreement.state] ?? a.agreement.state}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
