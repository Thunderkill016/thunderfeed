"use client";

import type { StoryCluster } from "../lib/model";

function BlindspotItem({
  cluster,
  onOpen,
}: {
  cluster: StoryCluster;
  onOpen: (c: StoryCluster) => void;
}) {
  return (
    <button className="blindspot-item" onClick={() => onOpen(cluster)}>
      <span className="blindspot-title">{cluster.title}</span>
      <span className="blindspot-meta">
        {cluster.sources.length} nguồn ·{" "}
        {cluster.sources
          .slice(0, 3)
          .map((s) => s.name)
          .join(", ")}
      </span>
    </button>
  );
}

/**
 * Ground-News-style blindspot: events covered by only one side of the
 * domestic/international divide.
 */
export default function BlindspotStrip({
  internationalOnly,
  domesticOnly,
  onOpen,
}: {
  internationalOnly: StoryCluster[];
  domesticOnly: StoryCluster[];
  onOpen: (c: StoryCluster) => void;
}) {
  return (
    <section className="blindspots">
      <h2 className="blindspots-title">Điểm mù truyền thông</h2>
      <div className="blindspot-cols">
        {internationalOnly.length > 0 && (
          <div className="blindspot-col">
            <h3>Quốc tế đưa — trong nước chưa đưa</h3>
            {internationalOnly.map((c) => (
              <BlindspotItem key={c.id} cluster={c} onOpen={onOpen} />
            ))}
          </div>
        )}
        {domesticOnly.length > 0 && (
          <div className="blindspot-col">
            <h3>Trong nước đưa — quốc tế chưa đưa</h3>
            {domesticOnly.map((c) => (
              <BlindspotItem key={c.id} cluster={c} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
