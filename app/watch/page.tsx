import type { Metadata } from "next";
import { getEdition } from "../../lib/edition";
import {
  parseWatch,
  emptyWatch,
  rankEdition,
  entitiesInEdition,
} from "../../lib/relevance";
import { topics, topicById } from "../../lib/model";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "ThunderFeed — Theo dõi",
};

/** Personal-mission surface: which events in the current edition touch
 *  the entities/topics you watch. URL-param driven so a watch list is
 *  shareable: /watch?e=vietnam,fed&t=business */
export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; t?: string }>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  if (sp.e) params.set("e", sp.e);
  if (sp.t) params.set("t", sp.t);
  const watch = parseWatch(params);
  const edition = await getEdition();
  const ranked = emptyWatch(watch) ? [] : rankEdition(edition, watch);
  const suggestions = entitiesInEdition(edition);

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const href = (e: string[], t: string[]) => {
    const p = new URLSearchParams();
    if (e.length) p.set("e", e.join(","));
    if (t.length) p.set("t", t.join(","));
    return `/watch${p.size ? `?${p}` : ""}`;
  };

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">THEO DÕI</span>
          <SiteNav active="watch" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {ranked.length > 0
              ? `${ranked.length} sự kiện khớp`
              : "edition hiện tại"}
          </span>
        </div>
      </header>

      <section className="macro-group">
        <h2 className="macro-group-title">Watchlist của bạn</h2>
        <p className="macro-notes">
          Chọn thực thể &amp; chủ đề — sự kiện trong edition hiện tại được xếp
          theo độ liên quan. Entity match nặng hơn topic match; chia sẻ được
          bằng URL.
        </p>

        {/* entity chips — tap to toggle, canonical slugs under the hood */}
        <div className="watch-chips">
          {suggestions.map((e) => {
            const on = watch.entities.includes(e);
            return (
              <a
                key={e}
                href={href(toggle(watch.entities, e), watch.topics)}
                className={`watch-chip${on ? " on" : ""}`}
              >
                {e}
              </a>
            );
          })}
        </div>
        <div className="watch-chips">
          {topics.map((t) => {
            const on = watch.topics.includes(t.id);
            return (
              <a
                key={t.id}
                href={href(watch.entities, toggle(watch.topics, t.id))}
                className={`watch-chip topic${on ? " on" : ""}`}
                style={on ? { borderColor: t.color, color: t.color } : {}}
              >
                {t.label}
              </a>
            );
          })}
        </div>

        {emptyWatch(watch) ? (
          <p className="macro-empty">
            Chọn entity hoặc chủ đề ở trên để xem sự kiện liên quan.
          </p>
        ) : ranked.length === 0 ? (
          <p className="macro-empty">
            Không có sự kiện nào trong edition hiện tại khớp watchlist.
          </p>
        ) : (
          <table className="macro-table">
            <thead>
              <tr>
                <th>Sự kiện</th>
                <th className="num">Liên quan</th>
                <th>Entity khớp</th>
                <th>Chủ đề</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ cluster: c, relevance: r }) => {
                const eventId = edition.eventIds?.[c.id];
                return (
                  <tr key={c.id}>
                    <td className="macro-name">
                      <a
                        className="macro-code"
                        href={eventId ? `/event/${eventId}` : c.leadArticle.url}
                        {...(eventId
                          ? {}
                          : { target: "_blank", rel: "noopener noreferrer" })}
                      >
                        {c.title}
                      </a>
                      <span className="macro-vi">
                        {c.summary.slice(0, 140)}
                      </span>
                    </td>
                    <td className="num macro-value">
                      {(r.score * 100).toFixed(0)}%
                    </td>
                    <td className="macro-date">
                      {r.matchedEntities.join(", ") || "—"}
                    </td>
                    <td className="macro-date">
                      {topicById.get(c.topic)?.label ?? c.topic}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
