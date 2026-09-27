"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { topics } from "../lib/model";
import { entityLabel } from "../lib/entities";
import { saveWatch } from "./WatchBar";
import type { WatchList } from "../lib/relevance";

/** Asset-family watch presets — these are INSTRUMENT watches, not
 *  entities: `vang` fans out to every gold board + SJC-PREM at match
 *  time, `ty_gia` to the FX stack. Kept out of `entities[]` so the
 *  canonical ontology stays clean. */
const ASSET_PRESETS: { slug: string; label: string }[] = [
  { slug: "vang", label: "Vàng" },
  { slug: "bitcoin", label: "Bitcoin" },
  { slug: "ethereum", label: "Ethereum" },
  { slug: "usdt", label: "USDT P2P" },
  { slug: "ty_gia", label: "Tỷ giá" },
  { slug: "vnindex", label: "VN-Index" },
];

const PRESET_LABEL = new Map(ASSET_PRESETS.map((p) => [p.slug, p.label]));

export function instrumentLabel(slug: string): string {
  return PRESET_LABEL.get(slug) ?? slug;
}

/** Homepage watch editor — the personal-relevance layer of the radar.
 *  Writes localStorage + the tf_watch cookie, then refreshes so the
 *  feed re-scores server-side. */
export default function RadarWatch({
  watch,
  suggested,
}: {
  watch: WatchList;
  suggested: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const active =
    watch.entities.length + watch.instruments.length + watch.topics.length > 0;

  const toggle = (
    kind: "entities" | "instruments" | "topics",
    value: string,
  ) => {
    const cur = new Set(watch[kind] as string[]);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    const next = { ...watch, [kind]: [...cur] };
    saveWatch(next);
    router.refresh();
  };

  return (
    <section className="watch-bar">
      <div className="watch-head">
        <h3 className="rail-title">Radar của tôi</h3>
        {active && !editing && (
          <div className="watch-chips suggest-inline">
            {watch.instruments.map((e) => (
              <span className="chip on" key={e}>
                {instrumentLabel(e)}
              </span>
            ))}
            {watch.entities.map((e) => (
              <span className="chip on" key={e}>
                {entityLabel(e)}
              </span>
            ))}
            {watch.topics.map((t) => (
              <span className="chip on" key={t}>
                {topics.find((x) => x.id === t)?.label ?? t}
              </span>
            ))}
          </div>
        )}
        <button className="watch-edit" onClick={() => setEditing((v) => !v)}>
          {editing ? "xong" : active ? "chỉnh" : "theo dõi"}
        </button>
      </div>

      {!active && !editing && (
        <div className="watch-chips suggest-inline">
          {ASSET_PRESETS.map((a) => (
            <button
              key={a.slug}
              className="chip"
              onClick={() => toggle("instruments", a.slug)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div className="watch-editor">
          <div className="watch-group">
            <span className="watch-label">Tài sản</span>
            <div className="watch-chips">
              {ASSET_PRESETS.map((a) => (
                <button
                  key={a.slug}
                  className={`chip ${watch.instruments.includes(a.slug) ? "on" : ""}`}
                  onClick={() => toggle("instruments", a.slug)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
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
          {suggested.length > 0 && (
            <div className="watch-group">
              <span className="watch-label">Sự kiện đang nóng</span>
              <div className="watch-chips">
                {suggested.map((e) => (
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
          )}
        </div>
      )}
    </section>
  );
}
