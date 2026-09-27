"use client";

import type { ChangeView, EventVersionView, EventView } from "../lib/db/read";
import { buildStoryArc, type ArcChange } from "../lib/changes";
import { fmtClaimValue, PRED_LABEL_VI } from "../lib/format";
import { TIER_LABEL, useReliability } from "./ReliabilityContext";

const CHANGE_LABEL: Record<string, string> = {
  event_created: "Sự kiện mới",
  new_claim: "Dữ kiện mới",
  claim_updated: "Cập nhật dữ kiện",
  claim_confirmed: "Xác nhận",
  claim_disputed: "Mâu thuẫn",
  claim_corrected: "Chỉnh sửa",
  claim_retracted: "Rút lại",
  new_primary_source: "Nguồn chính thức",
  new_coverage: "Thêm nguồn",
  new_independent_evidence: "Nguồn độc lập",
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

const fmtValue = (v: unknown, unit?: string | null): string =>
  v === null || v === undefined ? "—" : fmtClaimValue(v, unit);

export function changeLabel(t: string): string {
  return CHANGE_LABEL[t] ?? t;
}

/** Canonical intelligence — claims, positions, evidence buckets, timeline. */
export default function EventIntel({ view }: { view: EventView }) {
  const conf = view.confidence;
  const reliability = useReliability();
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
        {/* ICD 203: a confidence grade without reasoning is noise —
            show the evidence arithmetic behind the badge */}
        <p className="conf-why">
          {conf.confirmedIndependentOrigins} nguồn độc lập
          {conf.primaryOrigins > 0 && ` · ${conf.primaryOrigins} chính thức`}
          {conf.directEvidenceCount > 0 &&
            ` · ${conf.directEvidenceCount} dữ kiện có bằng chứng gốc`}
          {conf.unresolvedOrigins > 0 &&
            ` · ${conf.unresolvedOrigins} nguồn chưa rõ gốc`}
          {conf.contradictions > 0 && ` · ${conf.contradictions} mâu thuẫn mở`}
        </p>
        <ul className="claims-canonical">
          {view.claims.map((c) => (
            <li key={c.id}>
              <div className="claim-row">
                {/* Free-text predicates (LLM fact claims) carry no VI label —
                    for text-valued claims the value IS the claim, so the raw
                    snake_case key would just be noise. Numeric claims still
                    need a head, humanized when unmapped. */}
                {(PRED_LABEL_VI[c.predicate] ??
                  (typeof c.value !== "string" ? c.predicate : null)) && (
                  <span className="claim-pred">
                    {PRED_LABEL_VI[c.predicate] ??
                      c.predicate.replace(/_/g, " ")}
                  </span>
                )}
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
                  {items.slice(0, 6).map((e) => {
                    const tier = reliability.get(e.source);
                    return (
                      <li key={e.url}>
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {e.title}
                        </a>
                        <span className="ev-src">
                          {e.source}
                          {tier && tier !== "insufficient" && (
                            <em
                              className={`tier-badge ${tier}`}
                              title={TIER_LABEL[tier]}
                            >
                              {tier === "strong"
                                ? "●●●"
                                : tier === "moderate"
                                  ? "●●○"
                                  : "●○○"}
                            </em>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {view.latestChanges.length > 0 && (
        <section className="detail-section">
          <h3>Từ đầu tới giờ</h3>
          {buildStoryArc(view.latestChanges).map((d) => (
            <div key={d.label} className="arc-day">
              <span className="arc-day-label">{d.label}</span>
              <ul className="changes-timeline">
                {d.items.map((c, i) => (
                  <ChangeRow key={i} change={c} />
                ))}
              </ul>
            </div>
          ))}
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
          timeZone: "Asia/Ho_Chi_Minh",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </li>
  );
}

/** A single beat inside a story-arc day group — the day header carries
 *  the date, so the row shows VN-local time only. */
export function ChangeRow({ change }: { change: ArcChange }) {
  return (
    <li className={`change-row ${change.materiality}`}>
      <span className={`change-badge ${change.materiality}`}>
        {changeLabel(change.type)}
      </span>
      <span className="change-summary">{change.summary}</span>
      <span className="change-time">
        {new Date(change.detectedAt).toLocaleTimeString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </li>
  );
}
