"use client";

import { useEffect, useState } from "react";
import type { ChangeView } from "../lib/db/read";
import { changeLabel } from "./EventIntel";
import {
  groupChangesByEvent,
  materialityName,
  changeSummaryText,
  type EventChangeGroup,
} from "../lib/changes";

interface FeedChange extends ChangeView {
  eventId: string;
  eventTitle: string;
}

const POLL_MS = 120_000;
const MAX_CARDS = 12;

function cardMeta(g: EventChangeGroup): string {
  const parts: string[] = [];
  const first = g.substantive[0];
  if (first) {
    const label = changeLabel(first.type);
    const extra =
      g.substantive.length > 1 ? ` (+${g.substantive.length - 1})` : "";
    parts.push(`${label}: ${changeSummaryText(first, label)}${extra}`);
  }
  if (g.coverageSources.length) {
    const names = g.coverageSources.slice(0, 3).join(", ");
    const more =
      g.coverageSources.length > 3 ? ` +${g.coverageSources.length - 3}` : "";
    parts.push(`${g.coverageSources.length} nguồn: ${names}${more}`);
  }
  return parts.join(" · ");
}

/** "ĐIỀU GÌ VỪA THAY ĐỔI" — the canonical changes feed, material only.
 *  One card per event: coverage-type rows collapse to a source count so a
 *  hot event can't flood the rail with identical confirmations. */
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

  const groups = groupChangesByEvent(changes);

  return (
    <section className="changes-rail">
      <h3 className="rail-title">Điều gì vừa thay đổi</h3>
      <div className="rail-scroll">
        {groups.slice(0, MAX_CARDS).map((g) => {
          const lead = g.substantive[0] ?? g.items[0];
          const mat = materialityName(g.rank);
          return (
            <button
              key={g.key}
              className={`change-card ${mat}`}
              onClick={() => g.eventId && onOpenEvent(g.eventId)}
            >
              <span className={`change-badge ${mat}`}>
                {changeLabel(lead.type)}
              </span>
              <span className="change-card-event">{g.eventTitle}</span>
              <span className="change-card-summary">{cardMeta(g)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
