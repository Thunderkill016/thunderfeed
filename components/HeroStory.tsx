"use client";

import type { EventAnalysis, StoryCluster } from "../lib/model";
import { timeAgo } from "../lib/model";
import { MediaSpectrumBar, OwnershipBar } from "./Spectrum";
import { SourceAvatars } from "./SourceIcons";

const CONF_LABEL = {
  strong: "tin cậy cao",
  moderate: "tin cậy vừa",
  weak: "tin cậy thấp",
} as const;

export default function HeroStory({
  cluster,
  analysis,
  claimCount,
  confidence,
  isRead,
  now,
  onOpen,
}: {
  cluster: StoryCluster;
  analysis: EventAnalysis;
  claimCount?: number;
  confidence?: "strong" | "moderate" | "weak";
  isRead: boolean;
  now: number;
  onOpen: () => void;
}) {
  const facts = claimCount ?? analysis.claims?.consensus.length ?? 0;
  return (
    <section
      className={`hero ${isRead ? "read" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={cluster.title}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
    >
      <div className="hero-label">
        <span className="hero-kicker">Nhận định đầu trang</span>
        {cluster.isBreaking && <span className="breaking">Đang diễn biến</span>}
        {cluster.momentum?.phase === "accelerating" && (
          <span className="momentum-chip up">
            Đang leo · +{cluster.momentum.newArticles} bài
            {cluster.momentum.newSources.length > 0 &&
              `, +${cluster.momentum.newSources.length} nguồn`}
          </span>
        )}
        {cluster.momentum?.phase === "emerging" && (
          <span className="momentum-chip new">Mới nổi</span>
        )}
      </div>
      <div className="hero-grid">
        {cluster.leadArticle.image && (
          <div className="hero-image">
            <img
              src={cluster.leadArticle.image}
              alt=""
              loading="lazy"
              ref={(img) => {
                // cached/SSR-complete images finish before hydration —
                // their load event never fires, so check here too
                if (img?.complete) img.classList.add("loaded");
              }}
              onLoad={(e) => e.currentTarget.classList.add("loaded")}
            />
          </div>
        )}
        <div className="hero-body">
          <h1 className="hero-title">{cluster.title}</h1>
          <p className="hero-news">{analysis.theNews}</p>

          <div className="nhandinh-block">
            <span className="nhandinh-label">
              Nhận định
              {analysis.nhanDinh.origin === "gemini" && (
                <em className="ai-note">AI · {analysis.nhanDinh.model}</em>
              )}
            </span>
            <p className="nhandinh-text">{analysis.nhanDinh.text}</p>
          </div>

          <div className="hero-spectra">
            <MediaSpectrumBar spectrum={analysis.spectrum} />
            <OwnershipBar ownership={analysis.ownership} />
          </div>

          {analysis.headlines.length > 1 && (
            <div className="framing-strip">
              <span className="framing-label">Đối chiếu giật tít</span>
              <div className="framing-items">
                {analysis.headlines.slice(0, 3).map((h) => (
                  <div key={h.url} className="framing-item">
                    <span
                      className={`src-dot ${h.isDomestic ? "dom" : "intl"}`}
                    />
                    <span className="framing-src">{h.source}</span>
                    <span className="framing-title">{h.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="hero-meta">
            <SourceAvatars sources={cluster.sources} max={4} />
            {facts > 0 && (
              <>
                <span className="dot">·</span>
                <span className="claims-chip">{facts} dữ kiện</span>
              </>
            )}
            {confidence && (
              <>
                <span className="dot">·</span>
                <span className={`conf-badge ${confidence}`} title="Độ tin cậy">
                  {CONF_LABEL[confidence]}
                </span>
              </>
            )}
            <span className="dot">·</span>
            <span>{timeAgo(cluster.publishedAt, now)}</span>
            <span className="dot">·</span>
            <span>~{cluster.readingTimeMin} phút đọc</span>
          </div>
        </div>
      </div>
    </section>
  );
}
