"use client";

import { useEffect, useState } from "react";
import type { ChangeView } from "../lib/db/read";
import { changeLabel } from "./EventIntel";

interface FeedChange extends ChangeView {
  eventId: string;
  eventTitle: string;
}

const POLL_MS = 120_000;

/** "ĐIỀU GÌ VỪA THAY ĐỔI" — the canonical changes feed, material only. */
export default function ChangesRail({
  onOpenEvent,
}: {
  onOpenEvent: (eventId: string) => void;
}) {
  const [changes, setChanges] = useState<FeedChange[]>([]);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch("/api/changes", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as FeedChange[];
        if (!dead) setChanges(data);
      } catch {
        /* DB off or network error — rail stays hidden */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  if (changes.length === 0) return null;

  return (
    <section className="changes-rail">
      <h3 className="rail-title">Điều gì vừa thay đổi</h3>
      <div className="rail-scroll">
        {changes.slice(0, 12).map((c, i) => (
          <button
            key={`${c.eventId}-${i}`}
            className={`change-card ${c.materiality}`}
            onClick={() => onOpenEvent(c.eventId)}
          >
            <span className={`change-badge ${c.materiality}`}>
              {changeLabel(c.type)}
            </span>
            <span className="change-card-summary">{c.summary}</span>
            <span className="change-card-event">{c.eventTitle}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
