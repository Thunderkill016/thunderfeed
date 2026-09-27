import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dbEnabled } from "../../../lib/db/pool";
import { getEventView } from "../../../lib/db/read";
import { entityHref, entityKindLabel } from "../../../lib/entities";
import EventIntel from "../../../components/EventIntel";
import SiteNav from "../../../components/SiteNav";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const view = dbEnabled() ? await getEventView(id).catch(() => null) : null;
  return { title: `ThunderFeed — ${view?.title ?? "Sự kiện"}` };
}

const CONF_VI: Record<string, string> = {
  strong: "độ tin cậy cao",
  moderate: "độ tin cậy vừa",
  weak: "độ tin cậy thấp",
};

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!dbEnabled() || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const view = await getEventView(id);
  if (!view) notFound();
  const c = view.confidence;

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">SỰ KIỆN</span>
          <SiteNav active="news" />
        </div>
        <div className="masthead-right">
          <span className="edition-date">
            {view.status} · {c.state && (CONF_VI[c.state] ?? c.state)}
          </span>
        </div>
      </header>

      <section className="macro-detail">
        <h1 className="macro-detail-title">{view.title}</h1>
        <p className="macro-detail-meta">
          {new Date(view.firstSeenAt).toLocaleDateString("vi-VN")} →{" "}
          {new Date(view.lastUpdatedAt).toLocaleDateString("vi-VN")} ·{" "}
          {c.rawSourceCount} nguồn · {c.confirmedIndependentOrigins} nguồn độc
          lập đã xác nhận
          {c.contradictions > 0 && ` · ${c.contradictions} mâu thuẫn mở`}
        </p>
        {view.entities.length > 0 && (
          <div className="entity-chips" style={{ margin: "12px 0" }}>
            {view.entities.map((e) => (
              <a
                key={e.slug}
                href={entityHref(e.canonicalKey, e.slug) ?? `/entity/${e.slug}`}
                className={`entity-chip ${e.kind ?? "unknown"}`}
                title={
                  e.canonicalKey ??
                  (e.kind ? entityKindLabel(e.kind) : undefined)
                }
              >
                {e.label}
              </a>
            ))}
          </div>
        )}
        {view.summary && (
          <p className="macro-detail-latest">{view.summary}</p>
        )}
      </section>

      <EventIntel view={view} />
    </main>
  );
}
