import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import { getSourceReliability } from "../../lib/db/read";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ThunderFeed — Nguồn" };

const KIND_VI: Record<string, string> = {
  primary: "Chính thức",
  publisher: "Báo",
  wire: "Thông tấn xã",
  aggregator: "Tổng hợp",
};
const TIER_VI: Record<string, string> = {
  strong: "mạnh",
  moderate: "vừa",
  weak: "yếu",
  insufficient: "chưa đủ data",
};

export default async function SourcesPage() {
  const sources = dbEnabled() ? await getSourceReliability() : [];
  const sorted = [...sources].sort(
    (a, b) => b.documents - a.documents || b.score - a.score,
  );

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">NGUỒN</span>
          <SiteNav active="sources" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {sources.length} nguồn · reliability theo provenance
          </span>
        </div>
      </header>

      <section className="macro-group">
        <p className="macro-detail-meta" style={{ margin: "8px 0 16px" }}>
          Điểm nguồn tính từ lineage thực: bài <b>original</b> = tự điều tra,
          <b> derived</b> = dịch/viết lại wire. Claim outcomes đếm theo trạng
          thái cuối của claim, không phải lúc khẳng định.
        </p>
        <table className="macro-table">
          <thead>
            <tr>
              <th>Nguồn</th>
              <th>Loại</th>
              <th className="num">Bài</th>
              <th className="num">Tự có</th>
              <th className="num">Derived</th>
              <th className="num">Claims</th>
              <th className="num">Xác nhận</th>
              <th className="num">Tranh chấp</th>
              <th className="num">Điểm</th>
              <th>Tier</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.sourceId}>
                <td className="macro-code">{s.name}</td>
                <td>{KIND_VI[s.kind] ?? s.kind}</td>
                <td className="num">{s.documents}</td>
                <td className="num">{s.originals}</td>
                <td className="num">{s.derived}</td>
                <td className="num">{s.claimsAsserted}</td>
                <td className="num">{s.confirmed}</td>
                <td className="num">{s.disputed + s.corrected}</td>
                <td className="num macro-value">{s.score.toFixed(2)}</td>
                <td>
                  <span className={`change-badge ${s.tier}`}>
                    {TIER_VI[s.tier] ?? s.tier}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
