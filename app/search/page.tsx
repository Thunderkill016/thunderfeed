import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import SiteNav from "../../components/SiteNav";
import {
  getEntityList,
  getInstrumentList,
  getMacroSeriesList,
  searchEvents,
} from "../../lib/db/read";
import { seriesMeta } from "../../lib/seriesLabels";
import {
  entityHref,
  entityKindLabel,
  type EntityKind,
} from "../../lib/entities";
import { normalizeText } from "../../lib/model";

/* Unified search over the canonical graph — one query fans out to
 * events, entities, macro series and instruments. Substring matching on
 * normalized text; deterministic, no fuzzy ranking (each domain already
 * has its own ordering). */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "ThunderFeed — Tìm kiếm",
};

const MAX_PER_DOMAIN = 12;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const norm = normalizeText(query);

  let eventHits: Awaited<ReturnType<typeof searchEvents>> = [];
  let entityHits: Awaited<ReturnType<typeof getEntityList>> = [];
  let seriesHits: Awaited<ReturnType<typeof getMacroSeriesList>> = [];
  let instrHits: Awaited<ReturnType<typeof getInstrumentList>> = [];

  if (dbEnabled() && norm) {
    const [ev, ent, ser, ins] = await Promise.all([
      searchEvents(query, MAX_PER_DOMAIN),
      getEntityList(),
      getMacroSeriesList(),
      getInstrumentList(),
    ]);
    eventHits = ev;
    const has = (s: string | null | undefined) =>
      !!s && normalizeText(s).includes(norm);
    entityHits = ent
      .filter((e) => has(e.name) || has(e.canonicalKey))
      .slice(0, MAX_PER_DOMAIN);
    seriesHits = ser
      .filter(
        (s) =>
          has(s.seriesCode) ||
          has(s.title) ||
          has(seriesMeta(s.seriesCode)?.vi),
      )
      .slice(0, MAX_PER_DOMAIN);
    instrHits = ins
      .filter(
        (i) =>
          has(i.canonicalKey) ||
          has(i.name) ||
          has(i.ticker) ||
          has(i.issuerName),
      )
      .slice(0, MAX_PER_DOMAIN);
  }

  const total =
    eventHits.length + entityHits.length + seriesHits.length + instrHits.length;

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">TÌM KIẾM</span>
          <SiteNav active="search" />
        </div>
      </header>

      <section className="macro-detail">
        <form method="GET" action="/search" className="ask-form">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Sự kiện, entity, chỉ số vĩ mô, mã chứng khoán…"
            className="ask-input"
            autoFocus
          />
          <button type="submit" className="ask-submit">
            Tìm
          </button>
        </form>
        {norm && (
          <p className="macro-detail-meta">
            {total} kết quả cho “{query}”
          </p>
        )}
      </section>

      {eventHits.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">Sự kiện</h2>
          <table className="macro-table">
            <tbody>
              {eventHits.map((h) => (
                <tr key={h.id}>
                  <td className="macro-name">
                    <a href={`/event/${h.id}`} className="macro-code">
                      {h.title}
                    </a>
                    <span className="macro-vi">
                      {h.status} · {h.topic}
                    </span>
                  </td>
                  <td className="macro-date">
                    {new Date(h.lastUpdatedAt).toLocaleDateString("vi-VN")}
                  </td>
                  <td className="num">{Math.round(h.score * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {entityHits.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">Entity</h2>
          <table className="macro-table">
            <tbody>
              {entityHits.map((e) => (
                <tr key={e.id}>
                  <td className="macro-name">
                    <a
                      href={entityHref(e.canonicalKey) ?? `/entity/${e.id}`}
                      className="macro-code"
                    >
                      {e.name}
                    </a>
                    <span className="macro-vi">
                      {entityKindLabel(e.type as EntityKind)}
                    </span>
                  </td>
                  <td className="macro-date">
                    {e.macroCount > 0 && `${e.macroCount} series vĩ mô`}
                    {e.macroCount > 0 && e.instrumentCount > 0 && " · "}
                    {e.instrumentCount > 0 &&
                      `${e.instrumentCount} công cụ tài chính`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {seriesHits.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">Chỉ số vĩ mô</h2>
          <table className="macro-table">
            <tbody>
              {seriesHits.map((s) => (
                <tr key={s.id}>
                  <td className="macro-name">
                    <a href={`/macro/${s.seriesCode}`} className="macro-code">
                      {s.seriesCode}
                    </a>
                    <span className="macro-vi">
                      {seriesMeta(s.seriesCode)?.vi ?? s.title}
                    </span>
                  </td>
                  <td className="num macro-value">
                    {s.latestValue
                      ? Number(s.latestValue).toLocaleString("en-US")
                      : "—"}
                  </td>
                  <td className="macro-date">{s.latestObsDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {instrHits.length > 0 && (
        <section className="macro-group">
          <h2 className="macro-group-title">Chứng khoán</h2>
          <table className="macro-table">
            <tbody>
              {instrHits.map((i) => (
                <tr key={i.id}>
                  <td className="macro-name">
                    <a
                      href={`/instrument/${i.canonicalKey}`}
                      className="macro-code"
                    >
                      {i.ticker ?? i.canonicalKey}
                    </a>
                    <span className="macro-vi">
                      {i.name ?? i.canonicalKey}
                      {i.issuerName ? ` — ${i.issuerName}` : ""}
                    </span>
                  </td>
                  <td className="num macro-value">
                    {i.close ? Number(i.close).toLocaleString("en-US") : "—"}
                  </td>
                  <td className="macro-date">{i.closeDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {norm && total === 0 && (
        <p className="macro-empty">Không có kết quả nào cho “{query}”.</p>
      )}
    </main>
  );
}
