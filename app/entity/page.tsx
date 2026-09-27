import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import { getEntityList } from "../../lib/db/read";
import { entityHref } from "../../lib/entities";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ThunderFeed — Thực thể" };

const TYPE_VI: Record<string, string> = {
  country: "Quốc gia",
  company: "Công ty",
  central_bank: "Ngân hàng TW",
  government_body: "Cơ quan NN",
  multilateral_organization: "Tổ chức đa phương",
  region: "Khu vực",
  place: "Địa danh",
  person: "Nhân vật",
  commodity: "Hàng hóa",
  brand: "Thương hiệu",
  event_series: "Chuỗi sự kiện",
  topic: "Chủ đề",
};

export default async function EntityIndex() {
  const rows = dbEnabled() ? await getEntityList() : [];
  const withData = rows.filter((r) => r.macroCount + r.instrumentCount > 0);
  const rest = rows.filter((r) => r.macroCount + r.instrumentCount === 0);
  const byType = new Map<string, typeof rest>();
  for (const r of rest) {
    const arr = byType.get(r.type) ?? [];
    arr.push(r);
    byType.set(r.type, arr);
  }

  const Row = ({ r }: { r: (typeof rows)[number] }) => (
    <tr key={r.id}>
      <td className="macro-name">
        <a
          className="macro-code"
          href={entityHref(r.canonicalKey) ?? undefined}
        >
          {r.name}
        </a>
        <span className="macro-vi">{r.canonicalKey}</span>
      </td>
      <td>{TYPE_VI[r.type] ?? r.type}</td>
      <td className="num">{r.macroCount || "—"}</td>
      <td className="num">{r.instrumentCount || "—"}</td>
    </tr>
  );

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">THỰC THỂ</span>
          <SiteNav />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {rows.length} entities · canonical graph
          </span>
        </div>
      </header>

      <section className="macro-group">
        <h2 className="macro-group-title">Có dữ liệu gắn kèm</h2>
        <table className="macro-table">
          <thead>
            <tr>
              <th>Thực thể</th>
              <th>Loại</th>
              <th className="num">Chỉ số vĩ mô</th>
              <th className="num">Instruments</th>
            </tr>
          </thead>
          <tbody>
            {withData.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </tbody>
        </table>
      </section>

      {[...byType.entries()].map(([t, rs]) => (
        <section key={t} className="macro-group">
          <h2 className="macro-group-title">
            {TYPE_VI[t] ?? t} ({rs.length})
          </h2>
          <table className="macro-table">
            <tbody>
              {rs.map((r) => (
                <tr key={r.id}>
                  <td className="macro-name">
                    <a
                      className="macro-code"
                      href={entityHref(r.canonicalKey) ?? undefined}
                    >
                      {r.name}
                    </a>
                    <span className="macro-vi">{r.canonicalKey}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
