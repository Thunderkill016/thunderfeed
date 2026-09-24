"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ReliabilityTier = "strong" | "moderate" | "weak" | "insufficient";

/** name → tier map from /api/sources; absent entry = unrated */
const ReliabilityContext = createContext<Map<string, ReliabilityTier>>(
  new Map(),
);

export function ReliabilityProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Map<string, ReliabilityTier>>(new Map());
  useEffect(() => {
    let dead = false;
    void fetch("/api/sources", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (dead || !d?.sources) return;
        const m = new Map<string, ReliabilityTier>();
        for (const s of d.sources as { name: string; tier: ReliabilityTier }[])
          m.set(s.name, s.tier);
        setMap(m);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  return (
    <ReliabilityContext.Provider value={map}>
      {children}
    </ReliabilityContext.Provider>
  );
}

export function useReliability(): Map<string, ReliabilityTier> {
  return useContext(ReliabilityContext);
}

export const TIER_LABEL: Record<ReliabilityTier, string> = {
  strong: "tin cậy cao",
  moderate: "tin cậy vừa",
  weak: "tin cậy thấp",
  insufficient: "chưa đủ dữ liệu",
};
