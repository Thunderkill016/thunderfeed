"use client";

import { useEffect, useState } from "react";
import type { EventAnalysis, StoryCluster } from "../lib/model";
import type { EventView } from "../lib/db/read";
import { MediaSpectrumBar, OwnershipBar } from "./Spectrum";
import EventIntel from "./EventIntel";
import Modal from "./Modal";
import { timeAgo, typologyLabel, ownershipCamp } from "../lib/model";
import { entityHref, entityKindLabel } from "../lib/entities";

const CAMPS = [
  { key: "state", label: "Báo nhà nước VN" },
  { key: "private", label: "Báo tư nhân VN" },
  { key: "intl", label: "Báo quốc tế" },
] as const;

export default function EventDetail({
  cluster,
  analysis,
  eventId,
  now,
  onClose,
}: {
  cluster: StoryCluster;
  analysis: EventAnalysis;
  /** canonical event id — when set, the EventView is the source of truth */
  eventId?: string;
  now: number;
  onClose: () => void;
}) {
  const [view, setView] = useState<EventView | null>(null);
  useEffect(() => {
    if (!eventId) return;
    let dead = false;
    fetch(`/api/events/${eventId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => !dead && setView(v))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [eventId]);

  return (
    <Modal onClose={onClose} label={cluster.title}>
      <div className="modal-head">
        <span className="modal-kicker">
          {cluster.isBreaking ? "Đang diễn biến · " : ""}
          {timeAgo(cluster.publishedAt, now)} · {cluster.sources.length} nguồn
        </span>
        <h2 className="modal-title">{cluster.title}</h2>
        {view && view.entities.length > 0 && (
          <div className="entity-chips">
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
      </div>

      <div className="modal-body">
        <section className="detail-section">
          <h3>Sự kiện</h3>
          <p>{analysis.theNews}</p>
          {analysis.byTheNumbers.length > 0 && (
            <div className="numbers">
              {analysis.byTheNumbers.map((f) => (
                <div key={f.label} className="number-fact">
                  <span className="number-value">{f.value}</span>
                  <span className="number-label">{f.label}</span>
                  <span className="number-context">{f.context}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="detail-section nhandinh-section">
          <h3>
            Nhận định
            {analysis.nhanDinh.origin === "gemini" && (
              <em className="ai-note">AI · {analysis.nhanDinh.model}</em>
            )}
          </h3>
          <p className="nhandinh-text">{analysis.nhanDinh.text}</p>
          {analysis.nhanDinh.watchItems.length > 0 && (
            <div className="watch-items">
              <h4>Điểm cần theo dõi</h4>
              <ul>
                {analysis.nhanDinh.watchItems.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="detail-section">
          <h3>Phổ truyền thông</h3>
          <div className="spectra">
            <div>
              <span className="spectra-label">Trong nước ↔ Quốc tế</span>
              <MediaSpectrumBar spectrum={analysis.spectrum} />
            </div>
            <div>
              <span className="spectra-label">Nhà nước ↔ Tư nhân</span>
              <OwnershipBar ownership={analysis.ownership} />
            </div>
          </div>
        </section>

        <section className="detail-section">
          <h3>Đối chiếu giật tít</h3>
          <ul className="headline-compare">
            {analysis.headlines.map((h) => (
              <li key={h.url}>
                <div className="headline-src">
                  <span
                    className={`src-dot ${h.isDomestic ? "dom" : "intl"}`}
                  />
                  <strong>{h.source}</strong>
                  {h.ownerType && (
                    <span className="owner-badge">
                      {typologyLabel(h.ownerType)}
                    </span>
                  )}
                </div>
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="headline-title"
                >
                  {h.title}
                </a>
              </li>
            ))}
          </ul>
        </section>

        {(analysis.framing.domestic.length > 0 ||
          analysis.framing.international.length > 0) && (
          <section className="detail-section">
            <h3>Khác biệt framing</h3>
            <div className="framing-diff">
              <div>
                <span className="spectra-label">Trong nước nhấn</span>
                <div className="framing-terms">
                  {analysis.framing.domestic.map((t) => (
                    <span key={t} className="framing-term dom">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <span className="spectra-label">Quốc tế nhấn</span>
                <div className="framing-terms">
                  {analysis.framing.international.map((t) => (
                    <span key={t} className="framing-term intl">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {view && <EventIntel view={view} />}

        {!view && analysis.claims && (
          <section className="detail-section">
            <h3>
              Dữ kiện & bất đồng
              <em className="ai-note">AI · {analysis.claims.model}</em>
            </h3>
            {analysis.claims.consensus.length > 0 && (
              <ul className="claims-consensus">
                {analysis.claims.consensus.map((c) => (
                  <li key={c.point}>
                    <span className="claim-point">{c.point}</span>
                    <span className="claim-srcs">
                      {c.sources.slice(0, 3).join(" · ")}
                      {c.sources.length > 3 && ` +${c.sources.length - 3}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {analysis.claims.disputes.map((d) => (
              <div key={d.topic} className="dispute">
                <span className="dispute-topic">⚡ {d.topic}</span>
                <ul>
                  {d.positions.map((p) => (
                    <li key={p.source}>
                      <strong>{p.source}:</strong> {p.claim}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {analysis.timeline.length > 1 && (
          <section className="detail-section">
            <h3>Nhịp đưa tin — ai đưa trước</h3>
            <ul className="timeline">
              {analysis.timeline.slice(0, 8).map((t, i) => (
                <li key={t.source}>
                  <span className="tl-rank">
                    {i === 0 ? "▸" : `+${t.lagHours}h`}
                  </span>
                  <span
                    className={`src-dot ${t.isDomestic ? "dom" : "intl"}`}
                  />
                  <span className="tl-source">{t.source}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="detail-section">
          <h3>Góc nhìn từng phe</h3>
          {/* Vietnamese coverage splits on the state/private axis, not a
              partisan one — group sources into the camps a VN reader
              actually weighs against each other (Ground News's "Left/
              Center/Right say" adapted to the local axis). */}
          {CAMPS.map(({ key, label }) => {
            const items = analysis.theViewFrom.filter(
              (v) => ownershipCamp(v.ownerType, v.isDomestic ?? false) === key,
            );
            if (!items.length) return null;
            return (
              <div key={key} className="view-camp">
                <span className={`camp-label ${key}`}>
                  {label} · {items.length}
                </span>
                <ul className="view-from">
                  {items.map((v) => (
                    <li key={v.url ?? v.source}>
                      <div className="headline-src">
                        <span
                          className={`src-dot ${v.isDomestic ? "dom" : "intl"}`}
                        />
                        <strong>{v.source}</strong>
                        {v.ownerType && (
                          <span className="owner-badge">
                            {typologyLabel(v.ownerType)}
                          </span>
                        )}
                      </div>
                      <p>{v.summary}</p>
                      {v.url && (
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Đọc bài gốc →
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      </div>

      <div className="modal-foot">
        <a
          href={cluster.leadArticle.url}
          target="_blank"
          rel="noopener noreferrer"
          className="primary-link"
        >
          Đọc bài chính tại {cluster.leadArticle.source} →
        </a>
      </div>
    </Modal>
  );
}
