/* Telegram morning digest — ONE message per VN calendar day.
 *
 *   npx tsx scripts/telegram-digest.mts            # deliver today's digest
 *   npx tsx scripts/telegram-digest.mts --dry-run  # preview without sending
 *
 * Replaces the per-run alert cadence that was spamming: a digest is one
 * interruption with the whole picture — top edition events + last-24h
 * data deltas + watch hits — sent once per Asia/Ho_Chi_Minh day.
 * Dedup persists in delivery_state (channel 'telegram_digest').
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (required),
 *      TELEGRAM_WATCH (optional entity slugs), TF_SITE_URL.
 */
import { getLatestChanges, getLatestDataDeltas } from "../lib/db/read";
import { getLatestEditionSnapshot } from "../lib/db/editionSnapshot";
import { dbEnabled, getPool } from "../lib/db/pool";
import { sendTelegram } from "../lib/telegram";
import { deltaSummaryLabel } from "../lib/format";
import { seriesMeta } from "../lib/seriesLabels";

const CHANNEL = "telegram_digest";
const dryRun = process.argv.includes("--dry-run");
const SITE_URL = process.env.TF_SITE_URL ?? "https://thunderfeed.vercel.app";
const TOP_EVENTS = 6;
const TOP_DELTAS = 6;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const vnToday = () =>
  new Date().toLocaleString("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

async function loadLastDate(): Promise<string | null> {
  if (!dbEnabled()) return null;
  const { rows } = await getPool().query<{ state: { lastDate?: string } }>(
    `SELECT state FROM delivery_state WHERE channel = $1`,
    [CHANNEL],
  );
  return rows[0]?.state?.lastDate ?? null;
}

async function saveLastDate(d: string): Promise<void> {
  await getPool().query(
    `INSERT INTO delivery_state (channel, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (channel)
     DO UPDATE SET state = $2::jsonb, updated_at = now()`,
    [CHANNEL, JSON.stringify({ lastDate: d })],
  );
}

async function main() {
  const today = vnToday();
  const last = await loadLastDate();
  if (last === today) {
    console.log(`digest already delivered for ${today} (VN)`);
    return;
  }

  const edition = await getLatestEditionSnapshot();
  const deltas = await getLatestDataDeltas(40);
  const watch = (process.env.TELEGRAM_WATCH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const changes = await getLatestChanges(50, { tiers: ["high", "medium"] });

  const since24h = Date.now() - 24 * 3600e3;
  const freshDeltas = deltas.filter((d) => Date.parse(d.detectedAt) > since24h);

  const lines: string[] = [
    `☀️ <b>ThunderFeed — bản tin sáng ${today.split("-").reverse().join("/")}</b>`,
  ];

  // ── sự kiện nổi bật từ edition ──────────────────────────────────────
  const eventIds = edition?.eventIds ?? {};
  const seenEvents = new Set<string>();
  const eventLines: string[] = [];
  const pushEvent = (clusterId: string, title: string) => {
    const ev = eventIds[clusterId];
    if (seenEvents.has(ev ?? clusterId)) return;
    seenEvents.add(ev ?? clusterId);
    const n = eventLines.length + 1;
    eventLines.push(
      ev
        ? `${n}. <a href="${SITE_URL}/event/${ev}">${esc(title)}</a>`
        : `${n}. ${esc(title)}`,
    );
  };
  if (edition?.hero) pushEvent(edition.hero.id, edition.hero.title);
  for (const p of edition?.pillars ?? [])
    for (const e of p.events) {
      if (eventLines.length >= TOP_EVENTS) break;
      pushEvent(e.id, e.title);
    }
  if (eventLines.length) {
    lines.push("", "<b>Sự kiện đáng chú ý</b>", ...eventLines);
  }

  // ── dữ liệu thay đổi 24h ────────────────────────────────────────────
  if (freshDeltas.length) {
    lines.push("", `<b>Dữ liệu mới (${freshDeltas.length})</b>`);
    for (const d of freshDeltas.slice(0, TOP_DELTAS)) {
      const label =
        (d.seriesCode && seriesMeta(d.seriesCode)?.vi) ??
        deltaSummaryLabel(d.summary, d.seriesCode);
      lines.push(`• ${esc(label)}`);
    }
  }

  // ── watch hits ──────────────────────────────────────────────────────
  if (watch.length && changes.length) {
    const hit = changes.filter((c) =>
      watch.some((w) =>
        `${c.eventTitle ?? ""} ${c.summary ?? ""}`
          .toLowerCase()
          .includes(w.toLowerCase()),
      ),
    );
    if (hit.length) {
      lines.push("", `<b>Watchlist (${hit.length})</b>`);
      for (const c of hit.slice(0, 3))
        lines.push(`• ${esc(c.eventTitle ?? c.summary ?? "")}`);
    }
  }

  lines.push("", `<a href="${SITE_URL}">Mở ThunderFeed</a>`);
  const msg = lines.join("\n");

  console.log(`--- digest ${today} ---\n${msg}`);
  if (dryRun) return;
  if (!(await sendTelegram(msg))) {
    console.error("sendMessage failed");
    process.exit(1);
  }
  await saveLastDate(today);
  console.log(`digest delivered for ${today}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
