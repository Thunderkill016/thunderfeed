import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dbEnabled } from "../../../lib/db/pool";
import { getEntityEvents, getEntityMacroSeries } from "../../../lib/db/read";
import {
  entityHref,
  entityKindLabel,
  entityRelationshipLabel,
  entityTypeLabel,
} from "../../../lib/entities";
import { timeAgo } from "../../../lib/model";
import { seriesMeta } from "../../../lib/seriesLabels";

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
  params: Promise<{ path: string[] }>;
}): Promise<Metadata> {
  const { path } = await params;
  return { title: `ThunderFeed — ${path.join("/")}` };
}

export default async function EntityPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  // two address forms resolve the same entity:
  //   /entity/federal_reserve        legacy gazetteer slug
  //   /entity/central_bank/fed       canonical key (type:name)
  const slug =
    path.length === 1 && /^[a-z0-9_]{1,64}$/.test(path[0])
      ? path[0]
      : path.length === 2 && path.every((p) => /^[a-z0-9_]{1,64}$/.test(p))
        ? `${path[0]}:${path[1]}`
        : null;
  if (!slug || !dbEnabled()) notFound();
  const view = await getEntityEvents(slug);
  // macro series scoped to this entity — the wire from news events to the
  // official economic indicators of the country/institution being covered
  const macroSeries = view.entity
    ? await getEntityMacroSeries(view.entity.id)
    : [];
  // a slug outside the gazetteer with no junction rows is a clean 404 —
  // a known entity that merely has no coverage yet still gets a page
  if (view.kind === null && view.events.length === 0 && !view.entity)
    notFound();

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
          {view.entity && (
            <span className="entity-chip type">
              {entityTypeLabel(view.entity.type)}
            </span>
          )}
        </div>
        {view.entity && (
          <p className="entity-canonical">
            <code>{view.entity.canonicalKey}</code>
            {view.entity.countryCode && ` · ${view.entity.countryCode}`}
            {view.aliases.length > 1 &&
              ` · ${view.aliases
                .slice(0, 4)
                .map((a) => a.alias)
                .join(" · ")}`}
          </p>
        )}
        <p className="entity-stats">
          {view.events.length} sự kiện · {totalChanges} thay đổi được ghi nhận
        </p>
        {view.related.explicit.length > 0 && (
          <div className="entity-related">
            <span className="entity-related-label">Quan hệ:</span>
            <div className="entity-chips">
              {view.related.explicit.map((r) => {
                const text = `${entityRelationshipLabel(r.relationship)} · ${r.name}`;
                const title = `${r.name} — ${
                  r.direction === "out"
                    ? `${view.label} ${entityRelationshipLabel(r.relationship)} ${r.name}`
                    : `${r.name} ${entityRelationshipLabel(r.relationship)} ${view.label}`
                } (${r.canonicalKey})`;
                const href = entityHref(r.canonicalKey, r.gazetteerSlug);
                return href ? (
                  <a
                    key={`${r.direction}:${r.relationship}:${r.canonicalKey}`}
                    href={href}
                    className="entity-chip org"
                    title={title}
                  >
                    {text}
                  </a>
                ) : (
                  <span
                    key={`${r.direction}:${r.relationship}:${r.canonicalKey}`}
                    className="entity-chip org static"
                    title={title}
                  >
                    {text}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {view.financialInstruments.length > 0 && (
          <div className="entity-related">
            <span className="entity-related-label">Chứng khoán:</span>
            <div className="entity-chips">
              {view.financialInstruments.map((fi) => {
                const listing = fi.listings[0];
                const text = listing?.ticker
                  ? `${listing.ticker} · ${fi.name ?? fi.canonicalKey}`
                  : (fi.name ?? fi.canonicalKey);
                return (
                  <a
                    key={fi.id}
                    href={`/instrument/${fi.canonicalKey.split(":").join("/")}`}
                    className="entity-chip org"
                    title={`${fi.canonicalKey} — ${listing ? `${listing.venue.mic} · ${fi.type}` : fi.type}`}
                  >
                    {text}
                  </a>
                );
              })}
            </div>
          </div>
        )}
        {macroSeries.length > 0 && (
          <div className="entity-related">
            <span className="entity-related-label">Chỉ số vĩ mô:</span>
            <div className="entity-chips">
              {macroSeries.map((s) => (
                <a
                  key={s.id}
                  href={`/macro/${s.seriesCode}`}
                  className="entity-chip org macro-chip"
                  title={`${s.seriesCode} · ${s.title ?? ""} · kỳ ${s.latestObsDate ?? "—"} · vintage ${s.latestVintage ?? "—"}`}
                >
                  {seriesMeta(s.seriesCode)?.vi ?? s.seriesCode}
                  {s.latestValue != null && (
                    <b className="macro-chip-value">
                      {" "}
                      {Number(s.latestValue).toLocaleString("en-US")}
                    </b>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}
        {view.related.coOccurrence.length > 0 && (
          <div className="entity-related">
            <span className="entity-related-label">Cùng xuất hiện:</span>
            <div className="entity-chips">
              {view.related.coOccurrence.map((r) => (
                <a
                  key={r.slug}
                  href={
                    entityHref(r.canonicalKey, r.slug) ?? `/entity/${r.slug}`
                  }
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
        <EntityEventGroups events={view.events} label={view.label} now={now} />
      )}
    </main>
  );
}

type EntityEventRow = Awaited<
  ReturnType<typeof getEntityEvents>
>["events"][number];

function EntityEventGroups({
  events,
  label,
  now,
}: {
  events: EntityEventRow[];
  label: string;
  now: number;
}) {
  // headline entities headline the page; passing mentions stay visible
  // but visibly secondary — the reader sees what the event is ABOUT
  const about = events.filter((e) => e.inTitle);
  const mentions = events.filter((e) => !e.inTitle);
  const renderRow = (e: EntityEventRow) => (
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
  );
  return (
    <>
      {about.length > 0 && (
        <>
          <h2 className="entity-group-label">Sự kiện về {label}</h2>
          <ul className="entity-events">{about.map(renderRow)}</ul>
        </>
      )}
      {mentions.length > 0 && (
        <>
          <h2 className="entity-group-label muted">
            {about.length ? "Còn được nhắc trong" : `${label} được nhắc trong`}
          </h2>
          <ul className="entity-events muted">{mentions.map(renderRow)}</ul>
        </>
      )}
    </>
  );
}
