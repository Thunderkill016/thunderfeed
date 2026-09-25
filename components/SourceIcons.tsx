"use client";

import { useState } from "react";
import type { SourceRef } from "../lib/model";

function faviconHost(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return null;
  }
}

function Favicon({ source }: { source: SourceRef }) {
  const [dead, setDead] = useState(false);
  const host = faviconHost(source.url);
  if (!host || dead) {
    return (
      <span className="src-letter" title={source.name}>
        {source.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="src-favicon"
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`}
      alt=""
      title={source.name}
      loading="lazy"
      onError={() => setDead(true)}
    />
  );
}

/** Stacked source favicons + total count — cheap recognizability on cards. */
export function SourceAvatars({
  sources,
  max = 3,
}: {
  sources: SourceRef[];
  max?: number;
}) {
  if (!sources.length) return null;
  return (
    <span
      className="src-avatars"
      title={sources.map((s) => s.name).join(", ")}
    >
      <span className="src-icons">
        {sources.slice(0, max).map((s) => (
          <Favicon key={s.name} source={s} />
        ))}
      </span>
      <span className="src-count">{sources.length} nguồn</span>
    </span>
  );
}
