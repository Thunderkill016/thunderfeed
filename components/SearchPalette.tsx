"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Edition, StoryCluster } from "../lib/model";

type Hit = {
  kind: "event" | "wire";
  id: string;
  title: string;
  source: string;
  url?: string;
  cluster?: StoryCluster;
};

type AskResponse = {
  answer: string;
  origin: "gemini" | "extractive";
  events: { id: string; title: string; status: string; confidence: string }[];
};

export default function SearchPalette({
  edition,
  onClose,
  onOpen,
  onOpenEvent,
  normalizeText,
}: {
  edition: Edition;
  onClose: () => void;
  onOpen: (c: StoryCluster) => void;
  onOpenEvent: (eventId: string) => void;
  normalizeText: (s: string) => string;
}) {
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<AskResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allClusters = useMemo(() => {
    const seen = new Map<string, StoryCluster>();
    if (edition.hero) seen.set(edition.hero.id, edition.hero);
    for (const p of edition.pillars)
      for (const c of p.events) seen.set(c.id, c);
    for (const c of edition.blindspots.internationalOnly) seen.set(c.id, c);
    for (const c of edition.blindspots.domesticOnly) seen.set(c.id, c);
    return [...seen.values()];
  }, [edition]);

  const hits = useMemo<Hit[]>(() => {
    const terms = normalizeText(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    const matches = (text: string) => {
      const h = normalizeText(text);
      return terms.every((t) => h.includes(t));
    };
    const clusterHits: Hit[] = allClusters
      .map((c) => ({
        c,
        score: matches(c.title)
          ? 2
          : matches(
                `${c.summary} ${c.keyTakeaways?.join(" ") ?? ""} ${c.sources.map((s) => s.name).join(" ")} ${c.articles.map((a) => `${a.title} ${a.summary}`).join(" ")}`,
              )
            ? 1
            : 0,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ c }) => ({
        kind: "event" as const,
        id: c.id,
        title: c.title,
        source: `${c.sources.length} nguồn`,
        cluster: c,
      }));
    const wireHits: Hit[] = edition.wire
      .filter((a) => matches(`${a.title} ${a.summary} ${a.source}`))
      .slice(0, 15)
      .map((a) => ({
        kind: "wire" as const,
        id: a.id,
        title: a.title,
        source: a.source,
        url: a.url,
      }));
    return [...clusterHits, ...wireHits].slice(0, 20);
  }, [q, allClusters, edition.wire, normalizeText]);

  const ask = async () => {
    const question = q.trim();
    if (question.length < 3 || asking) return;
    setAsking(true);
    try {
      const res = await fetch(`/api/ask?q=${encodeURIComponent(question)}`, {
        cache: "no-store",
      });
      if (res.ok) setAsked(await res.json());
    } catch {
      /* keep search usable without ask */
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-box" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAsked(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          placeholder="Tìm kiếm hoặc đặt câu hỏi, Enter để hỏi…"
          className="search-input"
        />
        {(asking || asked) && (
          <div className="ask-result">
            {asking && !asked && (
              <span className="ask-loading">Đang phân tích…</span>
            )}
            {asked && (
              <>
                <p className="ask-answer">{asked.answer}</p>
                {asked.events.length > 0 && (
                  <div className="ask-events">
                    {asked.events.map((e, i) => (
                      <button
                        key={e.id}
                        className="ask-event"
                        onClick={() => {
                          onOpenEvent(e.id);
                          onClose();
                        }}
                      >
                        <span className="ask-num">[{i + 1}]</span>
                        <span className={`conf-badge ${e.confidence}`}>
                          {e.confidence}
                        </span>
                        {e.title}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <div className="search-results">
          {q && hits.length === 0 && (
            <div className="search-empty">Không có kết quả.</div>
          )}
          {hits.map((h) =>
            h.kind === "event" && h.cluster ? (
              <button
                key={h.id}
                className="search-hit"
                onClick={() => {
                  onOpen(h.cluster!);
                  onClose();
                }}
              >
                <span className="hit-kind">Sự kiện</span>
                <span className="hit-title">{h.title}</span>
                <span className="hit-src">{h.source}</span>
              </button>
            ) : (
              <a
                key={h.id}
                className="search-hit"
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
              >
                <span className="hit-kind">Wire</span>
                <span className="hit-title">{h.title}</span>
                <span className="hit-src">{h.source}</span>
              </a>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
