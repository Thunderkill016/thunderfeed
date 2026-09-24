"use client";

import { useEffect, useState } from "react";
import type { EventView } from "../lib/db/read";
import EventIntel from "./EventIntel";

const STATUS_LABEL: Record<string, string> = {
  active: "Đang diễn biến",
  developing: "Đang phát triển",
  resolved: "Đã lắng",
  monitoring: "Theo dõi",
};

/** Standalone canonical-event modal — opened from the changes rail. */
export default function EventModal({
  eventId,
  onClose,
}: {
  eventId: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<EventView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    fetch(`/api/events/${eventId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((v) => !dead && setView(v))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [eventId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button className="modal-close" onClick={onClose} aria-label="Đóng">
          ×
        </button>
        {view ? (
          <>
            <div className="modal-head">
              <span className="modal-kicker">
                {STATUS_LABEL[view.status] ?? view.status} ·{" "}
                {view.evidence.publishers.length +
                  view.evidence.primary.length +
                  view.evidence.community.length}{" "}
                nguồn ·{" "}
                {new Date(view.lastUpdatedAt).toLocaleString("vi-VN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  day: "numeric",
                  month: "numeric",
                })}
              </span>
              <h2 className="modal-title">{view.title}</h2>
            </div>
            <div className="modal-body">
              {view.summary && (
                <section className="detail-section">
                  <p>{view.summary}</p>
                </section>
              )}
              <EventIntel view={view} />
            </div>
          </>
        ) : (
          <div className="modal-body">
            <p className="muted">
              {failed ? "Không tải được sự kiện." : "Đang tải…"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
