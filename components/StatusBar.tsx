"use client";

import { useEffect, useState } from "react";
import type { SourceStatus } from "../lib/model";

export default function StatusBar({
  updatedAt,
  sources,
  totalArticles,
  llmEnabled,
  trending,
  changes,
}: {
  updatedAt: string | null;
  sources: SourceStatus[];
  totalArticles: number;
  llmEnabled: boolean;
  trending: { term: string; count: number }[];
  changes?: { newEvents: number; accelerating: number };
}) {
  // null until mounted — the live clock can't match SSR output by definition
  const [now, setNow] = useState<number | null>(null);
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const clock = now
    ? new Intl.DateTimeFormat("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Ho_Chi_Minh",
      }).format(now)
    : "--:--";

  const ageMin =
    updatedAt && now
      ? Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
      : null;
  const okCount = sources.filter((s) => s.status === "ok").length;
  const failed = sources.filter((s) => s.status === "error");

  return (
    <div className="statusbar">
      <div className="status-left">
        <span className="clock">
          {clock} <em>giờ VN</em>
        </span>
        <span className="dot">·</span>
        <span className="updated">
          {ageMin === null
            ? "đang tải"
            : ageMin < 1
              ? "vừa cập nhật"
              : `cập nhật ${ageMin} phút trước`}
        </span>
        <span className="dot">·</span>
        <button
          className="sources-btn"
          onClick={() => setShowSources((v) => !v)}
          title={`${okCount} nguồn đang hoạt động`}
        >
          {sources.length} nguồn
          {failed.length > 0 && ` · ${failed.length} lỗi`}
        </button>
        <span className="dot">·</span>
        <span className="art-count">
          {totalArticles.toLocaleString("vi-VN")} bài
        </span>
        {changes && changes.newEvents > 0 && (
          <span className="changes-tag">+{changes.newEvents} sự kiện mới</span>
        )}
        {changes && changes.accelerating > 0 && (
          <span className="changes-tag">▲{changes.accelerating} đang leo</span>
        )}
        {llmEnabled && <span className="ai-tag">nhận định AI</span>}
      </div>
      {trending.length > 0 && (
        <div className="trending">
          <span className="trending-label">Đang nóng:</span>
          {trending.slice(0, 8).map((t) => (
            <span key={t.term} className="trend-tag">
              {t.term}
            </span>
          ))}
        </div>
      )}
      {showSources && (
        <div className="sources-pop" onClick={() => setShowSources(false)}>
          <div className="sources-pop-inner">
            <h3>Tình trạng nguồn</h3>
            <ul>
              {sources.map((s) => (
                <li key={s.id} className={s.status}>
                  <span className={`status-dot ${s.status}`} />
                  <span className="src-name">{s.name}</span>
                  <span className="src-count">
                    {s.status === "ok" ? `${s.count} bài` : s.error}
                  </span>
                </li>
              ))}
            </ul>
            {failed.length > 0 && (
              <p className="sources-note">
                {failed.length} nguồn lỗi — bản tin vẫn đầy đủ từ các nguồn còn
                lại.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
