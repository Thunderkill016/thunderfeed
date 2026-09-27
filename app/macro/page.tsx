import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import SiteNav from "../../components/SiteNav";
import {
  getLatestDataDeltas,
  getMacroPoints,
  getMacroSeriesList,
} from "../../lib/db/read";

/* force-dynamic: the board is a live read of the DB — a build-time
 * prerender would freeze whatever state happened to exist (or crash the
 * build when the DB is unreachable). */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "ThunderFeed — Kinh tế vĩ mô",
};

/* Series → (group, vi label). Display config only — canonical identity is
 * the FRED code; a wrong label never corrupts the data layer. */
const GROUPS = {
  growth: "Tăng trưởng & hoạt động",
  inflation: "Lạm phát",
  labour: "Lao động",
  rates: "Lãi suất & đường cong",
  money: "Tiền & bảng cân đối Fed",
  markets: "Thị trường & rủi ro",
  fx: "Tỷ giá",
  world: "Thế giới",
} as const;
type GroupKey = keyof typeof GROUPS;

const SERIES_VI: Record<string, { g: GroupKey; vi: string }> = {
  GDPC1: { g: "growth", vi: "GDP thực (quý)" },
  INDPRO: { g: "growth", vi: "Sản xuất công nghiệp" },
  RSAFS: { g: "growth", vi: "Bán lẻ & dịch vụ ăn uống" },
  HOUST: { g: "growth", vi: "Khởi công nhà ở mới" },
  CPIAUCSL: { g: "inflation", vi: "CPI tiêu dùng (index)" },
  PCEPILFE: { g: "inflation", vi: "Core PCE — thước đo Fed ưa" },
  UMCSENT: { g: "inflation", vi: "Tâm lý người tiêu dùng (U.Mich)" },
  UNRATE: { g: "labour", vi: "Tỷ lệ thất nghiệp" },
  PAYEMS: { g: "labour", vi: "Việc làm phi nông nghiệp" },
  FEDFUNDS: { g: "rates", vi: "Fed Funds Rate" },
  DGS2: { g: "rates", vi: "Trái phiếu Kho bạc 2Y" },
  DGS10: { g: "rates", vi: "Trái phiếu Kho bạc 10Y" },
  T10Y2Y: { g: "rates", vi: "Độ dốc đường cong 10Y−2Y" },
  T10YIE: { g: "rates", vi: "Lạm phát kỳ vọng 10Y (breakeven)" },
  MORTGAGE30US: { g: "rates", vi: "Lãi vay mua nhà 30Y" },
  M2SL: { g: "money", vi: "Cung tiền M2" },
  WALCL: { g: "money", vi: "Bảng cân đối Fed (tài sản)" },
  SP500: { g: "markets", vi: "S&P 500" },
  VIXCLS: { g: "markets", vi: "VIX — biến động kỳ vọng" },
  BAMLH0A0HYM2: { g: "markets", vi: "Spread trái phiếu high-yield" },
  DCOILWTICO: { g: "markets", vi: "Dầu WTI ($/thùng)" },
  DTWEXBGS: { g: "fx", vi: "Chỉ số đô la (broad)" },
  DEXUSEU: { g: "fx", vi: "USD/EUR" },
  DEXJPUS: { g: "fx", vi: "JPY/USD" },
  DEXCHUS: { g: "fx", vi: "CNY/USD" },
  ECBDFR: { g: "world", vi: "Lãi suất ECB (deposit)" },
  FPCPITOTLZGCHN: { g: "world", vi: "CPI Trung Quốc (năm)" },
  FPCPITOTLZGJPN: { g: "world", vi: "CPI Nhật Bản (năm)" },
  FPCPITOTLZGDEU: { g: "world", vi: "CPI Đức (năm)" },
  FPCPITOTLZGGBR: { g: "world", vi: "CPI Anh (năm)" },
};

const PCT_UNITS = /percent|%|rate|yield|spread/i;

function delta(latest: number, prev: number, units: string | null) {
  const d = latest - prev;
  if (!Number.isFinite(d) || d === 0) return null;
  const pctLike = units ? PCT_UNITS.test(units) : false;
  // rate/yield/spread moves are quoted in basis points or points, not %
  const label = pctLike
    ? `${d > 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)} bp`
    : `${d > 0 ? "+" : "−"}${((Math.abs(d) / Math.abs(prev)) * 100).toFixed(1)}%`;
  return { label, up: d > 0 };
}

export default async function MacroPage() {
  if (!dbEnabled()) {
    return (
      <main className="edition">
        <p className="macro-empty">Database chưa cấu hình.</p>
      </main>
    );
  }
  const series = await getMacroSeriesList();
  const deltas = await getLatestDataDeltas(15);
  const latestTwo = await Promise.all(
    series.map((s) =>
      getMacroPoints(s.canonicalKey, { limit: 2, order: "desc" }),
    ),
  );
  const rows = series.map((s, i) => {
    const pts = latestTwo[i];
    const cur = pts[0] ?? null;
    const prev = pts[1] ?? null;
    const curN = cur ? Number(cur.value) : NaN;
    const prevN = prev ? Number(prev.value) : NaN;
    const d =
      cur && prev && Number.isFinite(curN) && Number.isFinite(prevN)
        ? delta(curN, prevN, s.units)
        : null;
    return { s, cur, prev, d };
  });
  const byGroup = new Map<GroupKey, typeof rows>();
  for (const r of rows) {
    const g = SERIES_VI[r.s.seriesCode]?.g ?? "world";
    byGroup.set(g, [...(byGroup.get(g) ?? []), r]);
  }

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">KINH TẾ VĨ MÔ</span>
          <SiteNav active="macro" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            FRED · dữ liệu chính thức · revision-aware
          </span>
        </div>
      </header>

      {[...byGroup.entries()].map(([g, rs]) => (
        <section key={g} className="macro-group">
          <h2 className="macro-group-title">{GROUPS[g]}</h2>
          <table className="macro-table">
            <thead>
              <tr>
                <th>Chỉ số</th>
                <th className="num">Giá trị</th>
                <th className="num">Δ kỳ trước</th>
                <th>Kỳ</th>
                <th>Vintage</th>
              </tr>
            </thead>
            <tbody>
              {rs.map(({ s, cur, d }) => (
                <tr key={s.id}>
                  <td className="macro-name">
                    <a href={`/macro/${s.seriesCode}`} className="macro-code">
                      {s.seriesCode}
                    </a>
                    <span className="macro-vi">
                      {SERIES_VI[s.seriesCode]?.vi ?? s.title ?? s.seriesCode}
                    </span>
                    {s.units && <span className="macro-units">{s.units}</span>}
                  </td>
                  <td className="num macro-value">
                    {cur ? Number(cur.value).toLocaleString("en-US") : "—"}
                  </td>
                  <td
                    className={`num macro-delta ${d ? (d.up ? "up" : "down") : ""}`}
                  >
                    {d ? d.label : "—"}
                  </td>
                  <td className="macro-date">{cur?.obsDate ?? "—"}</td>
                  <td className="macro-date">{cur?.vintageDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {deltas.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">Dữ liệu vừa thay đổi</h2>
          <table className="macro-table">
            <tbody>
              {deltas.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className={`delta-kind ${d.kind}`}>
                      {d.kind === "macro_revision"
                        ? "SỬA SỐ"
                        : d.kind === "macro_release"
                          ? "SỐ MỚI"
                          : d.kind === "ca_declared"
                            ? "CA MỚI"
                            : "CA SỬA"}
                    </span>
                  </td>
                  <td className="macro-name">
                    {d.seriesCode ? (
                      <a href={`/macro/${d.seriesCode}`} className="macro-code">
                        {d.summary}
                      </a>
                    ) : d.instrumentKey ? (
                      <a
                        href={`/instrument/${d.instrumentKey.split(":").join("/")}`}
                        className="macro-code"
                      >
                        {d.summary}
                      </a>
                    ) : (
                      d.summary
                    )}
                  </td>
                  <td className="macro-date">
                    {String(d.detectedAt).slice(0, 16).replace("T", " ")}
                  </td>
                  <td>
                    <span className={`change-badge ${d.materiality}`}>
                      {d.materiality}
                    </span>
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
