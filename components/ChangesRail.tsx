"use client";

import { useEffect, useState } from "react";
import type { ChangeView } from "../lib/db/read";
import { changeLabel } from "./EventIntel";
import {
  groupChangesByEvent,
  materialityName,
  changeSummaryText,
  MATERIALITY_ORDER,
  type EventChangeGroup,
} from "../lib/changes";

interface FeedChange extends ChangeView {
  eventId: string;
  eventTitle: string;
}

interface FeedDelta {
  id: string;
  kind: string;
  materiality: string;
  summary: string;
  detectedAt: string;
  seriesCode: string | null;
  instrumentKey: string | null;
}

const DELTA_LABEL: Record<string, string> = {
  macro_release: "SỐ MỚI",
  macro_revision: "SỬA SỐ",
  ca_declared: "CA MỚI",
  ca_updated: "CA SỬA",
};

function deltaHref(d: FeedDelta): string | null {
  if (d.seriesCode) return `/macro/${d.seriesCode}`;
  if (d.instrumentKey)
    return `/instrument/${d.instrumentKey.split(":").join("/")}`;
  return null;
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
  const [deltas, setDeltas] = useState<FeedDelta[]>([]);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch("/api/changes", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as FeedChange[];
          if (!dead) setChanges(data);
        }
        const dres = await fetch("/api/deltas", { cache: "no-store" });
        if (dres.ok) {
          const dd = (await dres.json()) as FeedDelta[];
          if (!dead) setDeltas(dd);
        }
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

  if (changes.length === 0 && deltas.length === 0) return null;

  const groups = groupChangesByEvent(changes);
  // one rail, two kinds of change: event groups (claims) interleave with
  // data deltas (macro/CA) on the same materiality+recency ordering
  const mixed: (
    | { t: "group"; rank: number; latest: number; g: EventChangeGroup }
    | { t: "delta"; rank: number; latest: number; d: FeedDelta }
  )[] = [
    ...groups.map((g) => ({
      t: "group" as const,
      rank: g.rank,
      latest: g.latest,
      g,
    })),
    ...deltas.map((d) => ({
      t: "delta" as const,
      rank: MATERIALITY_ORDER[d.materiality] ?? 2,
      latest: Date.parse(d.detectedAt) || 0,
      d,
    })),
  ];
  mixed.sort((a, b) => a.rank - b.rank || b.latest - a.latest);

  return (
    <section className="changes-rail">
      <h3 className="rail-title">Điều gì vừa thay đổi</h3>
      <div className="rail-scroll">
        {mixed.slice(0, MAX_CARDS).map((item) => {
          const mat = materialityName(item.rank);
          if (item.t === "delta") {
            const href = deltaHref(item.d);
            return (
              <a
                key={item.d.id}
                className={`change-card data ${mat}`}
                href={href ?? "#"}
              >
                <span className={`change-badge ${mat}`}>
                  {DELTA_LABEL[item.d.kind] ?? "DATA"}
                </span>
                <span className="change-card-event">{item.d.summary}</span>
                <span className="change-card-summary">dữ liệu canonical</span>
              </a>
            );
          }
          const g = item.g;
          const lead = g.substantive[0] ?? g.items[0];
          return (
            <button
              key={g.key}
              className={`change-card ${mat}`}
              disabled={!g.eventId}
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
