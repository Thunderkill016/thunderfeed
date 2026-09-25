"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Edition, StoryCluster } from "../lib/model";
import { normalizeText } from "../lib/model";
import StatusBar from "./StatusBar";
import HeroStory from "./HeroStory";
import PillarSection from "./PillarSection";
import BlindspotStrip from "./BlindspotStrip";
import WireRail from "./WireRail";
import EventDetail from "./EventDetail";
import EventModal from "./EventModal";
import ChangesRail from "./ChangesRail";
import SearchPalette from "./SearchPalette";
import WatchBar, {
  loadWatch,
  saveWatch,
  watchFromUrl,
  type WatchList,
} from "./WatchBar";

const READ_KEY = "thunderfeed:read";
const THEME_KEY = "thunderfeed:theme";
const POLL_MS = 60_000;

function loadRead(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export default function Edition({ initial }: { initial: Edition }) {
  const [edition, setEdition] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [dark, setDark] = useState(false);
  const [watch, setWatch] = useState<WatchList>({ entities: [], topics: [] });

  useEffect(() => {
    setRead(loadRead());
    const shared = watchFromUrl(window.location.search);
    if (shared) {
      setWatch(shared);
      saveWatch(shared);
    } else {
      setWatch(loadWatch());
    }
    const theme = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const isDark = theme ? theme === "dark" : prefersDark;
    setDark(isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    // deep link — Telegram alerts open ?event=<canonical event id>
    const eid = new URLSearchParams(window.location.search).get("event");
    if (eid) setOpenEventId(eid);
  }, []);

  const toggleTheme = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.dataset.theme = next ? "dark" : "light";
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/edition", { cache: "no-store" });
      if (res.ok) setEdition(await res.json());
    } catch {
      /* keep stale edition on network error */
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const markRead = useCallback((id: string) => {
    setRead((prev) => {
      const next = new Set(prev).add(id);
      localStorage.setItem(READ_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setOpenId(null);
        setOpenEventId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openCluster = useCallback(
    (cluster: StoryCluster) => {
      setOpenId(cluster.id);
      markRead(cluster.leadArticle.id);
    },
    [markRead],
  );

  const openAnalysis = edition.analyses[openId ?? ""] ?? null;
  const allClusters = useMemo(
    () => [
      ...(edition.hero ? [edition.hero] : []),
      ...edition.pillars.flatMap((p) => p.events),
      ...edition.blindspots.internationalOnly,
      ...edition.blindspots.domesticOnly,
    ],
    [edition],
  );

  const openEvent = useMemo(() => {
    if (!openId) return null;
    return allClusters.find((c) => c.id === openId) ?? null;
  }, [allClusters, openId]);

  const openClusterById = useCallback(
    (clusterId: string) => {
      const c = allClusters.find((x) => x.id === clusterId);
      if (c) openCluster(c);
    },
    [allClusters, openCluster],
  );

  const newCount = useMemo(() => {
    const seen = new Set(read);
    let n = 0;
    for (const p of edition.pillars)
      for (const e of p.events) if (!seen.has(e.leadArticle.id)) n++;
    return n;
  }, [edition, read]);

  // anchored to the edition snapshot — identical on server and client
  const nowMs = useMemo(
    () => (edition.updatedAt ? Date.parse(edition.updatedAt) : 0),
    [edition.updatedAt],
  );

  const dateStr = useMemo(
    () =>
      edition.updatedAt
        ? new Intl.DateTimeFormat("vi-VN", {
            weekday: "long",
            day: "numeric",
            month: "numeric",
            timeZone: "Asia/Ho_Chi_Minh",
          }).format(new Date(edition.updatedAt))
        : "",
    [edition.updatedAt],
  );

  return (
    <div className="edition">
      <header className="masthead">
        <div className="masthead-left">
          <span className="wordmark">ThunderFeed</span>
          <span className="edition-tag">Bản tin nhận định</span>
        </div>
        <div className="masthead-right">
          <span className="edition-date">{dateStr}</span>
          {newCount > 0 && (
            <span className="new-badge">{newCount} tin mới</span>
          )}
          <button
            className="icon-btn"
            onClick={() => setSearchOpen(true)}
            aria-label="Tìm kiếm (Ctrl+K)"
            title="Tìm kiếm (Ctrl+K)"
          >
            ⌕
          </button>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            aria-label="Đổi giao diện"
            title="Sáng/tối"
          >
            {dark ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <ChangesRail onOpenEvent={setOpenEventId} />

      <WatchBar
        watch={watch}
        setWatch={setWatch}
        editionVersion={edition.updatedAt ?? ""}
        onOpenCluster={openClusterById}
        onOpenEvent={setOpenEventId}
      />

      <StatusBar
        updatedAt={edition.updatedAt}
        sources={edition.sources}
        totalArticles={edition.totalArticles}
        llmEnabled={edition.llmEnabled}
        trending={edition.trending}
        changes={edition.changes}
      />

      <main className="main">
        {edition.hero && edition.heroAnalysis && (
          <HeroStory
            cluster={edition.hero}
            analysis={edition.heroAnalysis}
            claimCount={edition.claimCounts?.[edition.hero.id]}
            isRead={read.has(edition.hero.leadArticle.id)}
            now={nowMs}
            onOpen={() => openCluster(edition.hero!)}
          />
        )}

        <section className="pillars">
          {edition.pillars.map((pillar) => (
            <PillarSection
              key={pillar.id}
              pillar={pillar}
              analyses={edition.analyses}
              claimCounts={edition.claimCounts}
              read={read}
              now={nowMs}
              onOpen={openCluster}
            />
          ))}
        </section>

        {(edition.blindspots.internationalOnly.length > 0 ||
          edition.blindspots.domesticOnly.length > 0) && (
          <BlindspotStrip
            internationalOnly={edition.blindspots.internationalOnly}
            domesticOnly={edition.blindspots.domesticOnly}
            onOpen={openCluster}
          />
        )}

        {edition.wire.length > 0 && (
          <WireRail articles={edition.wire} read={read} now={nowMs} />
        )}
      </main>

      {searchOpen && (
        <SearchPalette
          edition={edition}
          onClose={() => setSearchOpen(false)}
          onOpen={openCluster}
          onOpenEvent={setOpenEventId}
          normalizeText={normalizeText}
        />
      )}

      {openEvent && openAnalysis && (
        <EventDetail
          cluster={openEvent}
          analysis={openAnalysis}
          eventId={edition.eventIds?.[openEvent.id]}
          now={nowMs}
          onClose={() => setOpenId(null)}
        />
      )}

      {openEventId && (
        <EventModal
          eventId={openEventId}
          onClose={() => setOpenEventId(null)}
        />
      )}
    </div>
  );
}
