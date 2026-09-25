"use client";

import type { EventAnalysis, Pillar, StoryCluster } from "../lib/model";
import { timeAgo, topicById } from "../lib/model";
import { MediaSpectrumBar } from "./Spectrum";
import { SourceAvatars } from "./SourceIcons";

const CONF_LABEL = {
  strong: "tin cậy cao",
  moderate: "tin cậy vừa",
  weak: "tin cậy thấp",
} as const;

function EventCard({
  cluster,
  analysis,
  claimCount,
  confidence,
  isRead,
  lead,
  now,
  onOpen,
}: {
  cluster: StoryCluster;
  analysis?: EventAnalysis;
  claimCount?: number;
  confidence?: "strong" | "moderate" | "weak";
  isRead: boolean;
  lead: boolean;
  now: number;
  onOpen: () => void;
}) {
  const topic = topicById.get(cluster.topic);
  const facts = claimCount ?? analysis?.claims?.consensus.length ?? 0;
  return (
    <article
      className={`event-card ${isRead ? "read" : ""} ${lead ? "lead" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
    >
      {lead && cluster.leadArticle.image && (
        <div className="card-thumb">
          <img src={cluster.leadArticle.image} alt="" loading="lazy" />
        </div>
      )}
      <div className="card-top">
        {topic && (
          <span className="topic-tag" style={{ color: topic.color }}>
            {topic.label}
          </span>
        )}
        <span className="card-time">
          {timeAgo(cluster.publishedAt, now, true)}
        </span>
      </div>
      <h3 className="card-title">{cluster.title}</h3>
      {analysis && (
        <p className="card-nhandinh">
          {analysis.nhanDinh.text.split(". ").slice(0, 2).join(". ") + "."}
        </p>
      )}
      <div className="card-foot">
        <SourceAvatars sources={cluster.sources} />
        {facts > 0 && <span className="claims-chip">{facts} dữ kiện</span>}
        {confidence && (
          <span className={`conf-badge ${confidence}`} title="Độ tin cậy">
            {CONF_LABEL[confidence]}
          </span>
        )}
        {cluster.mediaSpectrum && (
          <MediaSpectrumBar spectrum={cluster.mediaSpectrum} compact />
        )}
        {cluster.blindspot && (
          <span className="blindspot-chip">
            {cluster.blindspot === "domestic-only"
              ? "chỉ VN đưa"
              : "chỉ quốc tế đưa"}
          </span>
        )}
        {cluster.momentum?.phase === "accelerating" && (
          <span className="momentum-chip up">
            ▲ +{cluster.momentum.newArticles}
          </span>
        )}
        {cluster.momentum?.phase === "emerging" && (
          <span className="momentum-chip new">mới</span>
        )}
      </div>
    </article>
  );
}

export default function PillarSection({
  pillar,
  analyses,
  claimCounts,
  confidences,
  read,
  now,
  onOpen,
}: {
  pillar: Pillar;
  analyses: Record<string, EventAnalysis>;
  claimCounts?: Record<string, number>;
  confidences?: Record<string, "strong" | "moderate" | "weak">;
  read: Set<string>;
  now: number;
  onOpen: (c: StoryCluster) => void;
}) {
  if (!pillar.events.length) return null;
  return (
    <section className="pillar">
      <header className="pillar-head">
        <h2>{pillar.label}</h2>
        <span className="pillar-count">{pillar.events.length}</span>
      </header>
      <div className="pillar-events">
        {pillar.events.map((c, i) => (
          <EventCard
            key={c.id}
            cluster={c}
            analysis={analyses[c.id]}
            claimCount={claimCounts?.[c.id]}
            confidence={confidences?.[c.id]}
            isRead={read.has(c.leadArticle.id)}
            lead={i === 0}
            now={now}
            onOpen={() => onOpen(c)}
          />
        ))}
      </div>
    </section>
  );
}
