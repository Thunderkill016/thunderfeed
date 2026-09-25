"use client";

import { useState } from "react";
import type { SourceRef } from "../lib/model";
import { TIER_LABEL, useReliability } from "./ReliabilityContext";

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
  const reliability = useReliability();
  const tier = reliability.get(source.name);
  const rated = tier && tier !== "insufficient" ? tier : null;
  const tip = rated ? `${source.name} — ${TIER_LABEL[rated]}` : source.name;
  const host = faviconHost(source.url);
  if (!host || dead) {
    return (
      <span
        className={`src-letter${rated ? ` tier-${rated}` : ""}`}
        title={tip}
      >
        {source.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className={`src-favicon${rated ? ` tier-${rated}` : ""}`}
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`}
      alt=""
      title={tip}
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
    <span className="src-avatars" title={sources.map((s) => s.name).join(", ")}>
      <span className="src-icons">
        {sources.slice(0, max).map((s) => (
          <Favicon key={s.name} source={s} />
        ))}
      </span>
      <span className="src-count">{sources.length} nguồn</span>
    </span>
  );
}
