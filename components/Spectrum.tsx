import type { MediaSpectrum, OwnershipSpectrum } from "../lib/model";

/** Two-axis coverage spectrum: trong nước ↔ quốc tế + nhà nước ↔ tư nhân. */
export function MediaSpectrumBar({
  spectrum,
  compact = false,
}: {
  spectrum: MediaSpectrum;
  compact?: boolean;
}) {
  const intl = spectrum.internationalPct;
  const dom = spectrum.domesticPct;
  return (
    <div className={`spectrum ${compact ? "compact" : ""}`}>
      <div
        className="spectrum-bar"
        role="img"
        aria-label={`Trong nước ${dom}%, quốc tế ${intl}%`}
      >
        <div className="spectrum-dom" style={{ width: `${dom}%` }} />
        <div className="spectrum-intl" style={{ width: `${intl}%` }} />
      </div>
      {!compact && (
        <div className="spectrum-legend">
          <span className="legend-dom">Trong nước {dom}%</span>
          <span className="legend-intl">Quốc tế {intl}%</span>
        </div>
      )}
    </div>
  );
}

export function OwnershipBar({ ownership }: { ownership: OwnershipSpectrum }) {
  const total =
    ownership.stateCount + ownership.privateCount + ownership.unknownCount;
  if (!total) return null;
  const statePct = Math.round((ownership.stateCount / total) * 100);
  const privPct = Math.round((ownership.privateCount / total) * 100);
  const unkPct = 100 - statePct - privPct;
  return (
    <div className="spectrum ownership">
      <div
        className="spectrum-bar"
        role="img"
        aria-label={`Nhà nước ${statePct}%, tư nhân ${privPct}%`}
      >
        <div className="spectrum-state" style={{ width: `${statePct}%` }} />
        <div className="spectrum-priv" style={{ width: `${privPct}%` }} />
        <div className="spectrum-unk" style={{ width: `${unkPct}%` }} />
      </div>
      <div className="spectrum-legend">
        <span className="legend-state">Nhà nước {statePct}%</span>
        <span className="legend-priv">Tư nhân {privPct}%</span>
        {unkPct > 0 && <span className="legend-unk">Chưa rõ {unkPct}%</span>}
      </div>
    </div>
  );
}
