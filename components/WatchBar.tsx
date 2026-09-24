"use client";

import { useEffect, useMemo, useState } from "react";
import { topics, type Topic } from "../lib/model";
import { entityLabel } from "../lib/entities";
import { changeLabel } from "./EventIntel";
import type { ChangeView } from "../lib/db/read";

export interface WatchList {
  entities: string[];
  topics: Topic[];
}

const WATCH_KEY = "thunderfeed:watch";
const POLL_MS = 120_000;

export function loadWatch(): WatchList {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "{}");
    return {
      entities: Array.isArray(raw.entities) ? raw.entities : [],
      topics: Array.isArray(raw.topics) ? raw.topics : [],
    };
  } catch {
    return { entities: [], topics: [] };
  }
}

export function saveWatch(w: WatchList) {
  localStorage.setItem(WATCH_KEY, JSON.stringify(w));
}

/** URL `?e=a,b&t=x,y` overrides storage so a link is shareable. */
export function watchFromUrl(search: string): WatchList | null {
  const p = new URLSearchParams(search);
  const e = p.get("e");
  const t = p.get("t");
  if (!e && !t) return null;
  const entities = (e ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const topicsList = (t ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Topic => topics.some((x) => x.id === s));
  return { entities, topics: topicsList };
}

interface RankedItem {
  id: string;
  title: string;
  score: number;
  matchedEntities: string[];
  topicMatch: boolean;
}
interface AlertItem extends ChangeView {
  eventId: string;
  eventTitle: string;
}

/** "DÀNH CHO BẠN" — personal mission rail: watched entities/topics scored
    server-side against the canonical edition + material-change alerts. */
export default function WatchBar({
  watch,
  setWatch,
  editionVersion,
  onOpenCluster,
  onOpenEvent,
}: {
  watch: WatchList;
  setWatch: (w: WatchList) => void;
  /** bump when the edition refreshes so scores recompute */
  editionVersion: string;
  onOpenCluster: (clusterId: string) => void;
  onOpenEvent: (eventId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [ranked, setRanked] = useState<RankedItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const active = watch.entities.length + watch.topics.length > 0;

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (watch.entities.length) p.set("e", watch.entities.join(","));
    if (watch.topics.length) p.set("t", watch.topics.join(","));
    return p.toString();
  }, [watch]);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/relevance?${query}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          clusters: RankedItem[];
          availableEntities: string[];
        };
        if (dead) return;
        setRanked(data.clusters);
        setAvailable(data.availableEntities);
      } catch {
        /* edition not ready — rail keeps last data */
      }
    };
    void load();
    return () => {
      dead = true;
    };
  }, [query, editionVersion]);

  useEffect(() => {
    if (watch.entities.length === 0) {
      setAlerts([]);
      return;
    }
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/alerts?e=${watch.entities.join(",")}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { alerts: AlertItem[] };
        if (!dead) setAlerts(data.alerts);
      } catch {
        /* DB off — alerts hidden */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [watch.entities]);

  const toggle = (kind: "entities" | "topics", value: string) => {
    const cur = new Set(watch[kind] as string[]);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    const next = { ...watch, [kind]: [...cur] };
    setWatch(next);
    saveWatch(next);
  };

  return (
    <section className="watch-bar">
      <div className="watch-head">
        <h3 className="rail-title">Dành cho bạn</h3>
        {alerts.length > 0 && (
          <span className="alert-badge">{alerts.length} cảnh báo</span>
        )}
        <button className="watch-edit" onClick={() => setEditing((v) => !v)}>
          {editing ? "xong" : active ? "chỉnh" : "theo dõi chủ đề"}
        </button>
      </div>

      {editing && (
        <div className="watch-editor">
          <div className="watch-group">
            <span className="watch-label">Chủ đề</span>
            <div className="watch-chips">
              {topics.map((t) => (
                <button
                  key={t.id}
                  className={`chip ${watch.topics.includes(t.id) ? "on" : ""}`}
                  onClick={() => toggle("topics", t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="watch-group">
            <span className="watch-label">Tổ chức / địa điểm</span>
            <div className="watch-chips">
              {available.map((e) => (
                <button
                  key={e}
                  className={`chip ${watch.entities.includes(e) ? "on" : ""}`}
                  onClick={() => toggle("entities", e)}
                >
                  {entityLabel(e)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {!editing && !active && (
        <div className="watch-suggest">
          <span className="watch-label">Gợi ý theo dõi nhanh</span>
          <div className="watch-chips">
            {available.slice(0, 6).map((e) => (
              <button
                key={e}
                className="chip"
                onClick={() => toggle("entities", e)}
              >
                {entityLabel(e)}
              </button>
            ))}
            {available.length === 0 && (
              <span className="watch-empty">
                Chọn "theo dõi chủ đề" để nhận tin theo sự kiện bạn quan tâm.
              </span>
            )}
          </div>
        </div>
      )}

      {!editing && active && (
        <div className="watch-body">
          {alerts.slice(0, 3).map((a, i) => (
            <button
              key={`a-${a.eventId}-${i}`}
              className="watch-alert"
              onClick={() => onOpenEvent(a.eventId)}
            >
              <span className={`change-badge ${a.materiality}`}>
                {changeLabel(a.type)}
              </span>
              {a.summary}
            </button>
          ))}
          {ranked.slice(0, 6).map((r) => (
            <button
              key={r.id}
              className="watch-item"
              onClick={() => onOpenCluster(r.id)}
            >
              <span className="watch-score">{Math.round(r.score * 100)}</span>
              <span className="watch-item-title">{r.title}</span>
              {r.matchedEntities.length > 0 && (
                <span className="watch-matched">
                  {r.matchedEntities.map(entityLabel).join(" · ")}
                </span>
              )}
            </button>
          ))}
          {ranked.length === 0 && alerts.length === 0 && (
            <span className="watch-empty">
              Chưa có sự kiện nào khớp danh sách theo dõi.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
