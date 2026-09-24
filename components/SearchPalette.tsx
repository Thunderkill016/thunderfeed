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

export default function SearchPalette({
  edition,
  onClose,
  onOpen,
  normalizeText,
}: {
  edition: Edition;
  onClose: () => void;
  onOpen: (c: StoryCluster) => void;
  normalizeText: (s: string) => string;
}) {
  const [q, setQ] = useState("");
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
    const query = normalizeText(q);
    if (!query) return [];
    const clusterHits: Hit[] = allClusters
      .filter((c) =>
        normalizeText(
          `${c.title} ${c.summary} ${c.sources.map((s) => s.name).join(" ")}`,
        ).includes(query),
      )
      .map((c) => ({
        kind: "event" as const,
        id: c.id,
        title: c.title,
        source: `${c.sources.length} nguồn`,
        cluster: c,
      }));
    const wireHits: Hit[] = edition.wire
      .filter((a) =>
        normalizeText(`${a.title} ${a.summary} ${a.source}`).includes(query),
      )
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

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-box" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm kiếm (không cần dấu)…"
          className="search-input"
        />
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
