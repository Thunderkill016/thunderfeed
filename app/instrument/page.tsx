import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import { getInstrumentList } from "../../lib/db/read";
import { entityHref } from "../../lib/entities";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ThunderFeed — Chứng khoán" };

const TYPE_VI: Record<string, string> = {
  common_stock: "cổ phiếu",
  preferred_stock: "ưu đãi",
  etf: "ETF",
  depositary_receipt: "ADR",
  index: "chỉ số",
};

export default async function InstrumentIndex() {
  const rows = dbEnabled() ? await getInstrumentList() : [];
  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">CHỨNG KHOÁN</span>
          <SiteNav active="markets" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {rows.length} instruments · canonical identity
          </span>
        </div>
      </header>

      <section className="macro-group">
        <table className="macro-table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Listing</th>
              <th>Issuer</th>
              <th className="num">Giá đóng</th>
              <th>Phiên</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.id}-${r.ticker ?? ""}`}>
                <td className="macro-name">
                  <a
                    href={`/instrument/${r.canonicalKey.split(":").join("/")}`}
                    className="macro-code"
                  >
                    {r.name ?? r.canonicalKey}
                  </a>
                  <span className="macro-vi">{TYPE_VI[r.type] ?? r.type}</span>
                </td>
                <td className="macro-code">
                  {r.ticker ?? "—"}
                  {r.venueMic && (
                    <span className="macro-units">{r.venueMic}</span>
                  )}
                </td>
                <td>
                  {r.issuerKey && entityHref(r.issuerKey) ? (
                    <a
                      className="macro-entity-link"
                      href={entityHref(r.issuerKey)!}
                    >
                      {r.issuerName ?? r.issuerKey}
                    </a>
                  ) : (
                    (r.issuerName ?? "—")
                  )}
                </td>
                <td className="num macro-value">
                  {r.close != null
                    ? `${Number(r.close).toLocaleString("en-US")} ${r.currency ?? ""}`
                    : "—"}
                </td>
                <td className="macro-date">{r.closeDate ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
