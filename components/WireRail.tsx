"use client";

import { useState } from "react";
import type { Article } from "../lib/model";
import { timeAgo, topicById } from "../lib/model";

/** Raw wire: latest articles not yet clustered — chronological, glanceable. */
export default function WireRail({
  articles,
  read,
  now,
}: {
  articles: Article[];
  read: Set<string>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="wire">
      <button className="wire-toggle" onClick={() => setOpen((v) => !v)}>
        <h2>Dòng wire mới nhất</h2>
        <span className="wire-meta">
          {articles.length} bài chưa gom cụm {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <ul className="wire-list">
          {articles.map((a) => (
            <li key={a.id} className={read.has(a.id) ? "read" : ""}>
              <span className="wire-time">
                {timeAgo(a.publishedAt, now, true)}
              </span>
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {a.title}
              </a>
              <span className="wire-src">{a.source}</span>
              {topicById.get(a.topic) && (
                <span
                  className="wire-topic"
                  style={{ color: topicById.get(a.topic)!.color }}
                >
                  {topicById.get(a.topic)!.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
