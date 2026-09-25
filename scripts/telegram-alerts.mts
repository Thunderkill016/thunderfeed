/**
 * Telegram alert delivery — run on a schedule (cron/systemd):
 *
 *   npx tsx scripts/telegram-alerts.mts            # deliver new material changes
 *   npx tsx scripts/telegram-alerts.mts --dry-run  # preview without sending
 *
 * Env (in .env.local):
 *   TELEGRAM_BOT_TOKEN   — bot token (required)
 *   TELEGRAM_CHAT_ID     — recipient chat id (required)
 *   TELEGRAM_WATCH       — optional comma-separated entity slugs;
 *                          unset ⇒ deliver ALL medium/high materiality changes
 *
 * Dedup: delivered change ids persist in the delivery_state row when
 * DATABASE_URL is set (durable across ephemeral runners like GitHub
 * Actions), falling back to data/alert-state.json otherwise (capped).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getChangesForEntities, getLatestChanges } from "../lib/db/read";
import { dbEnabled, getPool } from "../lib/db/pool";
import { formatAlertMessages, sendTelegram } from "../lib/telegram";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const STATE_PATH = "data/alert-state.json";
const STATE_CAP = 2000;
const CHANNEL = "telegram";
const dryRun = process.argv.includes("--dry-run");

interface State {
  delivered: string[];
}

async function loadState(): Promise<{ state: State; existed: boolean }> {
  if (dbEnabled()) {
    try {
      const { rows } = await getPool().query<{ state: State }>(
        `SELECT state FROM delivery_state WHERE channel = $1`,
        [CHANNEL],
      );
      if (rows.length) {
        const s = rows[0].state;
        return {
          state: { delivered: Array.isArray(s.delivered) ? s.delivered : [] },
          existed: true,
        };
      }
      return { state: { delivered: [] }, existed: false };
    } catch {
      /* table absent pre-0009 — fall through to file */
    }
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
    return {
      state: {
        delivered: Array.isArray(raw.delivered) ? raw.delivered : [],
      },
      existed: true,
    };
  } catch {
    return { state: { delivered: [] }, existed: false };
  }
}

async function saveState(delivered: string[]): Promise<void> {
  if (dbEnabled()) {
    try {
      await getPool().query(
        `INSERT INTO delivery_state (channel, state, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (channel)
         DO UPDATE SET state = $2::jsonb, updated_at = now()`,
        [CHANNEL, JSON.stringify({ delivered })],
      );
      return;
    } catch {
      /* fall back to file */
    }
  }
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ delivered }, null, 1));
}

async function main() {
  const watch = (process.env.TELEGRAM_WATCH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const changes = watch.length
    ? await getChangesForEntities(watch, 50)
    : await getLatestChanges(50);

  const { state, existed } = await loadState();
  const seen = new Set(state.delivered);
  const fresh = changes.filter((c) => !seen.has(c.id));

  // first run: seed the watermark instead of dumping the whole backlog —
  // an alert channel that opens with 50 stale items is noise, not signal
  if (!existed) {
    for (const c of changes) seen.add(c.id);
    const delivered = [...seen].slice(-STATE_CAP);
    if (!dryRun) {
      await saveState(delivered);
      await sendTelegram(
        `⚡ ThunderFeed — đã kết nối.\n` +
          `Đang theo dõi ${changes.length} thay đổi gần đây; chỉ thay đổi MỚI từ giờ sẽ được gửi.`,
      );
    }
    console.log(`initialized state (${delivered.length} ids)`);
    return;
  }

  if (!fresh.length) {
    console.log("no new material changes");
    return;
  }

  // oldest-first so the digest reads chronologically
  fresh.reverse();
  const messages = formatAlertMessages(fresh);
  console.log(
    `${fresh.length} new changes → ${messages.length} message(s)` +
      (dryRun ? " [dry-run]" : ""),
  );
  if (dryRun) {
    for (const m of messages) console.log(`---\n${m}`);
    return;
  }

  let sent = 0;
  for (const m of messages) {
    if (await sendTelegram(m)) sent++;
    else console.error("sendMessage failed — stopping to retry next run");
    if (!sent) break;
  }
  if (!sent) process.exit(1);

  for (const c of fresh) seen.add(c.id);
  const delivered = [...seen].slice(-STATE_CAP);
  await saveState(delivered);
  console.log(`delivered ${sent} message(s), state=${delivered.length} ids`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
