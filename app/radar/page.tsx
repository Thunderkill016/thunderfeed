import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import {
  getGoldPremium,
  getMarketDeltas,
  getRadarBoard,
  getSignalOutcomeStats,
  type RadarSeriesRow,
} from "../../lib/db/read";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ThunderFeed — Radar tín hiệu" };

/** Board ordering for a VN investor — domestic gold leads because the
 *  SJC/world spread is the differentiated signal, then VN equities,
 *  crypto majors, FX, indices, anything else. */
const GROUP_ORDER = [
  "commodity",
  "equity",
  "crypto",
  "fx",
  "index",
  "fixed_income",
];
const KIND_VI: Record<string, string> = {
  market_move: "GIÁ ĐỘT BIẾN",
  premium_shift: "CHÊNH DỊCH",
  volume_spike: "VOL ĐỘT BIẾN",
};

const GROUP_VI: Record<string, string> = {
  commodity: "VÀNG & HÀNG HÓA",
  equity: "CỔ PHIẾU",
  crypto: "CRYPTO",
  fx: "TỶ GIÁ",
  index: "CHỈ SỐ",
  fixed_income: "TRÁI PHIẾU",
};

function fmt(v: string | number | null, currency?: string | null): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4;
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return currency ? `${s} ${currency}` : s;
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

function groupRows(rows: RadarSeriesRow[]) {
  const byClass = new Map<string, RadarSeriesRow[]>();
  for (const r of rows) {
    // indices carry asset_class 'equity' in the instrument master —
    // instrument_type is the honest grouping for the board
    const k =
      r.instrumentType === "index" ? "index" : (r.assetClass ?? "other");
    byClass.set(k, [...(byClass.get(k) ?? []), r]);
  }
  const keys = [...byClass.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((k) => ({ key: k, rows: byClass.get(k)! }));
}

export default async function RadarPage() {
  const [board, premium, stats, marketDeltas] = dbEnabled()
    ? await Promise.all([
        getRadarBoard(),
        getGoldPremium(),
        getSignalOutcomeStats(),
        getMarketDeltas(15),
      ])
    : [[], null, [], []];
  const groups = groupRows(board);
  const resolved = stats.filter((s) => s.status === "resolved");
  const pending = stats
    .filter((s) => s.status === "pending")
    .reduce((a, s) => a + s.count, 0);

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">RADAR TÍN HIỆU</span>
          <SiteNav active="radar" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {board.length} series · {groups.length} nhóm tài sản
          </span>
        </div>
      </header>

      {premium && (
        <section className="macro-group">
          <h2 className="macro-group-title">
            Chênh lệch SJC − thế giới
            <span className="macro-units">
              quy đổi VND/lượng · 1 lượng = 1.2057 oz
            </span>
          </h2>
          <table className="macro-table">
            <tbody>
              <tr>
                <td className="macro-name">
                  SJC bán ra
                  <span className="macro-vi">{premium.sjcDate}</span>
                </td>
                <td className="num macro-value">{fmt(premium.sjcSell)} ₫</td>
                <td className="macro-name" rowSpan={3}>
                  Chênh lệch
                  <span className="macro-vi">
                    {premium.premiumPct >= 0 ? "+" : ""}
                    {premium.premiumPct.toFixed(2)}%
                  </span>
                </td>
                <td className="num macro-value" rowSpan={3}>
                  {fmt(premium.spreadVnd)} ₫
                </td>
              </tr>
              <tr>
                <td className="macro-name">
                  Thế giới quy đổi
                  <span className="macro-vi">
                    XAU {fmt(premium.xauUsd)} USD/oz ({premium.xauDate}) ×
                    USDVND {fmt(premium.usdVnd)} ({premium.fxDate})
                  </span>
                </td>
                <td className="num macro-value">
                  {fmt(Math.round(premium.worldVndLuong))} ₫
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {groups.map((g) => (
        <section className="macro-group" key={g.key}>
          <h2 className="macro-group-title">
            {GROUP_VI[g.key] ?? g.key.toUpperCase()}
            <span className="macro-units">{g.rows.length} series</span>
          </h2>
          <table className="macro-table">
            <thead>
              <tr>
                <th>Tài sản</th>
                <th>Mã</th>
                <th className="num">Giá mới nhất</th>
                <th className="num">± phiên</th>
                <th>Phiên</th>
                <th>Nguồn</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.seriesId}>
                  <td className="macro-name">
                    <a
                      href={`/instrument/${r.instrumentKey.split(":").join("/")}`}
                      className="macro-code"
                    >
                      {r.name ?? r.instrumentKey}
                    </a>
                    {r.unit && <span className="macro-vi">{r.unit}</span>}
                  </td>
                  <td className="macro-code">
                    {r.ticker ?? "—"}
                    {r.venueMic && (
                      <span className="macro-units">{r.venueMic}</span>
                    )}
                  </td>
                  <td className="num macro-value">{fmt(r.close)}</td>
                  <td className="num">
                    <Pct v={r.dayChangePct} />
                  </td>
                  <td className="macro-date">{r.sessionDate}</td>
                  <td className="macro-units">
                    {r.provider}
                    {r.priceBasis === "quoted" ? " · quoted" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="macro-group">
        <h2 className="macro-group-title">
          Tín hiệu gần đây
          <span className="macro-units">{marketDeltas.length} delta</span>
        </h2>
        {marketDeltas.length === 0 ? (
          <p className="macro-units" style={{ padding: "0.6rem 0" }}>
            Chưa có tín hiệu nào — delta chỉ mint khi một phiên vượt ngưỡng
            materiality của series (vàng ±1.5%, crypto ±8%, FX ±0.5%, premium
            ±0.75pt).
          </p>
        ) : (
          <table className="macro-table">
            <tbody>
              {marketDeltas.map((d) => (
                <tr key={d.id}>
                  <td className="macro-name">
                    <span className="macro-code">
                      {KIND_VI[d.kind] ?? d.kind}
                    </span>
                    {d.ticker && <span className="macro-vi">{d.ticker}</span>}
                  </td>
                  <td className="macro-code">{d.summary}</td>
                  <td className="macro-date">{d.sessionDate ?? "—"}</td>
                  <td className="macro-units">{d.materiality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="macro-group">
        <h2 className="macro-group-title">
          Hồ sơ tín hiệu
          <span className="macro-units">
            market_move · premium_shift · volume_spike → T+1/T+5/T+20 phiên
          </span>
        </h2>
        {stats.length === 0 ? (
          <p className="macro-units" style={{ padding: "0.6rem 0" }}>
            Chưa có tín hiệu nào — mỗi delta tự động được chấm điểm khi đủ phiên
            theo dõi.
          </p>
        ) : (
          <table className="macro-table">
            <thead>
              <tr>
                <th>Chu kỳ</th>
                <th className="num">Đã chốt</th>
                <th className="num">Đang chờ</th>
                <th className="num">TB biên độ</th>
                <th className="num">Tiếp diễn</th>
              </tr>
            </thead>
            <tbody>
              {[1, 5, 20].map((h) => {
                const r = resolved.find((s) => s.horizon === h);
                const p = stats.find(
                  (s) => s.horizon === h && s.status === "pending",
                );
                return (
                  <tr key={h}>
                    <td className="macro-code">T+{h}</td>
                    <td className="num">{r?.count ?? 0}</td>
                    <td className="num">{p?.count ?? 0}</td>
                    <td className="num">
                      {r?.avgMovePct != null ? <Pct v={r.avgMovePct} /> : "—"}
                    </td>
                    <td className="num">
                      {r && r.count > 0
                        ? `${Math.round((r.continued / r.count) * 100)}%`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {pending > 0 && (
          <p className="macro-units">{pending} outcome đang chờ đủ phiên.</p>
        )}
      </section>
    </main>
  );
}
