"use client";

import type { ChangeView, EventVersionView, EventView } from "../lib/db/read";

const CHANGE_LABEL: Record<string, string> = {
  new_claim: "Dữ kiện mới",
  claim_updated: "Cập nhật dữ kiện",
  claim_confirmed: "Xác nhận",
  claim_disputed: "Mâu thuẫn",
  claim_corrected: "Chỉnh sửa",
  claim_retracted: "Rút lại",
  new_primary_source: "Nguồn chính thức",
  new_coverage: "Thêm nguồn",
  event_resolved: "Kết thúc",
  new_event: "Sự kiện mới",
};

const VERSION_REASON_LABEL: Record<string, string> = {
  event_created: "Tạo mới",
  new_material_claim: "Dữ kiện mới",
  claim_updated: "Cập nhật dữ kiện",
  claim_corrected: "Chỉnh sửa",
  claim_disputed: "Mâu thuẫn",
  primary_confirmation: "Xác nhận chính thức",
  event_resolved: "Kết thúc",
  manual: "Thủ công",
};

const VERSION_STATUS_LABEL: Record<string, string> = {
  emerging: "mới nổi",
  active: "đang diễn",
  stable: "ổn định",
  resolved: "kết thúc",
};

const STATE_LABEL: Record<string, string> = {
  reported: "đang đưa",
  confirmed: "xác nhận",
  disputed: "mâu thuẫn",
  corrected: "đã sửa",
  retracted: "đã rút",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  strong: "độ tin cậy cao",
  moderate: "độ tin cậy vừa",
  weak: "độ tin cậy thấp",
};

function fmtValue(v: unknown, unit?: string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const r = v as { low?: unknown; high?: unknown };
    if (r.low !== undefined && r.high !== undefined)
      return `${r.low}–${r.high}${unit ? ` ${unit}` : ""}`;
    return JSON.stringify(v);
  }
  return `${String(v)}${unit ? ` ${unit}` : ""}`;
}

export function changeLabel(t: string): string {
  return CHANGE_LABEL[t] ?? t;
}

/** Canonical intelligence — claims, positions, evidence buckets, timeline. */
export default function EventIntel({ view }: { view: EventView }) {
  const conf = view.confidence;
  return (
    <>
      <section className="detail-section">
        <h3>
          Dữ kiện chuẩn
          <em className={`conf-badge ${conf.state}`}>
            {CONFIDENCE_LABEL[conf.state] ?? conf.state}
          </em>
          {conf.contradictions > 0 && (
            <em className="contra-badge">⚡ {conf.contradictions} mâu thuẫn</em>
          )}
        </h3>
        <ul className="claims-canonical">
          {view.claims.map((c) => (
            <li key={c.id}>
              <div className="claim-row">
                <span className="claim-pred">{c.predicate}</span>
                <strong className="claim-val">
                  {fmtValue(c.value, c.unit)}
                </strong>
                <span className={`claim-state ${c.state}`}>
                  {STATE_LABEL[c.state] ?? c.state}
                </span>
                {c.previousValue !== undefined && (
                  <span className="claim-prev">
                    trước: {fmtValue(c.previousValue, c.unit)}
                  </span>
                )}
              </div>
              {c.positions && c.positions.length > 1 && (
                <div className="positions">
                  {c.positions.map((p, i) => (
                    <div key={i} className="position">
                      <strong>
                        {String.fromCharCode(65 + i)}:{" "}
                        {fmtValue(p.value, c.unit)}
                      </strong>
                      <span className="position-srcs">
                        {p.sources.join(" · ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="claim-meta">
                {c.evidenceCount} bằng chứng
                {c.primaryEvidenceCount > 0 &&
                  ` · ${c.primaryEvidenceCount} chính thức`}
              </div>
            </li>
          ))}
          {view.claims.length === 0 && (
            <li className="muted">Chưa có dữ kiện cấu trúc.</li>
          )}
        </ul>
      </section>

      <section className="detail-section">
        <h3>Nguồn bằng chứng</h3>
        <div className="ev-buckets">
          {(
            [
              ["primary", "Chính thức"],
              ["publishers", "Báo chí"],
              ["community", "Cộng đồng"],
            ] as const
          ).map(([key, label]) => {
            const items = view.evidence[key];
            if (!items.length) return null;
            return (
              <div key={key} className="ev-bucket">
                <span className="spectra-label">
                  {label} · {items.length}
                </span>
                <ul>
                  {items.slice(0, 6).map((e) => (
                    <li key={e.url}>
                      <a href={e.url} target="_blank" rel="noopener noreferrer">
                        {e.title}
                      </a>
                      <span className="ev-src">{e.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {view.latestChanges.length > 0 && (
        <section className="detail-section">
          <h3>Diễn biến</h3>
          <ul className="changes-timeline">
            {view.latestChanges.map((c, i) => (
              <ChangeRow key={i} change={c} />
            ))}
          </ul>
        </section>
      )}

      {view.versions.length > 1 && (
        <section className="detail-section">
          <h3>Phiên bản</h3>
          <ul className="changes-timeline">
            {view.versions.map((v, i) => (
              <VersionRow
                key={v.versionNo}
                version={v}
                prev={view.versions[i + 1]}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function VersionRow({
  version,
  prev,
}: {
  version: EventVersionView;
  prev?: EventVersionView;
}) {
  const titleChanged = prev && prev.title !== version.title;
  return (
    <li className="change-row">
      <span className="change-badge">v{version.versionNo}</span>
      <span className="change-summary">
        {VERSION_STATUS_LABEL[version.status] ?? version.status} ·{" "}
        {VERSION_REASON_LABEL[version.changeReason] ?? version.changeReason}
        {titleChanged && (
          <span className="version-title"> — “{version.title}”</span>
        )}
      </span>
      <span className="change-time">
        {new Date(version.effectiveAt).toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </li>
  );
}

export function ChangeRow({ change }: { change: ChangeView }) {
  const at = new Date(change.detectedAt);
  const isToday = at.toDateString() === new Date().toDateString();
  return (
    <li className={`change-row ${change.materiality}`}>
      <span className={`change-badge ${change.materiality}`}>
        {changeLabel(change.type)}
      </span>
      <span className="change-summary">{change.summary}</span>
      <span className="change-time">
        {isToday
          ? at.toLocaleTimeString("vi-VN", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : at.toLocaleString("vi-VN", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
      </span>
    </li>
  );
}
