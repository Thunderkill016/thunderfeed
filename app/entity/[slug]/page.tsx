import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dbEnabled } from "../../../lib/db/pool";
import { getEntityEvents } from "../../../lib/db/read";
import { entityKindLabel } from "../../../lib/entities";
import { timeAgo } from "../../../lib/model";

export const revalidate = 60;
export const maxDuration = 60;

const STATUS_VI: Record<string, string> = {
  emerging: "mới nổi",
  active: "đang diễn",
  stable: "ổn định",
  resolved: "kết thúc",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `ThunderFeed — ${slug}` };
}

export default async function EntityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9_]{1,64}$/.test(slug) || !dbEnabled()) notFound();
  const view = await getEntityEvents(slug);
  // a slug outside the gazetteer with no junction rows is a clean 404 —
  // a known entity that merely has no coverage yet still gets a page
  if (view.kind === null && view.events.length === 0) notFound();

  const now = Date.now();
  const totalChanges = view.events.reduce((n, e) => n + e.changeCount, 0);

  return (
    <main className="entity-page">
      <header className="entity-head">
        <a href="/" className="entity-back">
          ← ThunderFeed
        </a>
        <div className="entity-title-row">
          <h1>{view.label}</h1>
          {view.kind && (
            <span className={`entity-chip ${view.kind}`}>
              {entityKindLabel(view.kind)}
            </span>
          )}
        </div>
        <p className="entity-stats">
          {view.events.length} sự kiện · {totalChanges} thay đổi được ghi nhận
        </p>
        {view.related.length > 0 && (
          <div className="entity-related">
            <span className="entity-related-label">Liên quan:</span>
            <div className="entity-chips">
              {view.related.map((r) => (
                <a
                  key={r.slug}
                  href={`/entity/${r.slug}`}
                  className={`entity-chip ${r.kind ?? "unknown"}`}
                  title={
                    r.kind
                      ? `${entityKindLabel(r.kind)} · ${r.shared} sự kiện chung`
                      : `${r.shared} sự kiện chung`
                  }
                >
                  {r.label}
                </a>
              ))}
            </div>
          </div>
        )}
      </header>

      {view.events.length === 0 ? (
        <p className="entity-empty">
          Chưa có sự kiện nào được ghi nhận cho thực thể này.
        </p>
      ) : (
        <ul className="entity-events">
          {view.events.map((e) => (
            <li key={e.id} className="entity-event">
              <a href={`/?event=${e.id}`} className="entity-event-title">
                {e.title}
              </a>
              <div className="entity-event-meta">
                <span className={`entity-status ${e.status}`}>
                  {STATUS_VI[e.status] ?? e.status}
                </span>
                <span>{timeAgo(e.lastSeenAt, now)}</span>
                {e.changeCount > 0 && <span>{e.changeCount} thay đổi</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
