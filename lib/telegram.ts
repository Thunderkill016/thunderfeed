/**
 * Telegram delivery — Bot API client for the alert layer. Token/chat id
 * come from env only (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); nothing is
 * persisted.
 *
 * Design (Ground News / Kagi-style): push is an interruption budget.
 * One message per run — the single most important event group gets the
 * alert (breaking-style if it's a new event, else its top deltas), and
 * everything else collapses to a one-line footer pointing at the app.
 * Messages are HTML parse_mode: titles render bold + link back to the
 * event page; all source text is escaped so arbitrary summaries can't
 * break markup.
 */
import {
  dedupChanges,
  groupChangesByEvent,
  changeSummaryText,
  type ChangeLike,
} from "./changes";

const API = "https://api.telegram.org";
const SEND_TIMEOUT = 10_000;
/** Telegram hard limit per message */
const MSG_LIMIT = 4096;

export function telegramEnabled(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID,
  );
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, MSG_LIMIT),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const CHANGE_LABEL: Record<string, string> = {
  event_created: "Sự kiện mới",
  new_claim: "Dữ kiện mới",
  claim_updated: "Cập nhật dữ kiện",
  claim_confirmed: "Xác nhận",
  claim_disputed: "Mâu thuẫn",
  claim_corrected: "Chỉnh sửa",
  claim_retracted: "Rút lại",
  new_primary_source: "Nguồn chính thức",
  new_coverage: "Thêm nguồn",
  new_independent_evidence: "Nguồn độc lập",
  event_resolved: "Kết thúc",
  new_event: "Sự kiện mới",
};

type DigestChange = ChangeLike;

/** substantive lines shown in the single alert — a push reads top-facts,
 *  not the full claim diff; the rest stay on the event page */
const MAX_LINES_PER_EVENT = 3;
/** order claims inside an event block: conflicts and corrections are
 *  the reason a reader opens the alert; plain "new claim" trails */
const TYPE_PRIORITY: Record<string, number> = {
  claim_disputed: 0,
  claim_corrected: 1,
  claim_retracted: 2,
  claim_updated: 3,
  claim_confirmed: 4,
  new_claim: 5,
};

const isNewEvent = (t: string) => t === "event_created" || t === "new_event";

const link = (
  siteUrl: string | undefined,
  c: { eventId?: string },
): string | null =>
  siteUrl && c.eventId ? `${siteUrl}/?event=${c.eventId}` : null;

const titleHtml = (
  siteUrl: string | undefined,
  c: { eventId?: string; eventTitle: string },
): string => {
  const href = link(siteUrl, c);
  const t = esc(c.eventTitle);
  return href ? `<b><a href="${href}">${t}</a></b>` : `<b>${t}</b>`;
};

/** Standalone alert for a genuinely new important event — one message,
 *  self-contained: title, its first hard facts, who's reporting, link. */
function formatBreaking(
  g: {
    eventId?: string;
    eventTitle: string;
    substantive: ChangeLike[];
    coverageSources: string[];
  },
  siteUrl: string | undefined,
): string {
  const lines = ["🚨 <b>SỰ KIỆN MỚI</b>", "", titleHtml(siteUrl, g)];
  const top = g.substantive
    .filter((c) => !isNewEvent(c.type))
    .sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9))
    .slice(0, MAX_LINES_PER_EVENT);
  for (const c of top)
    lines.push(
      `• ${esc(changeSummaryText(c, CHANGE_LABEL[c.type] ?? c.type))}`,
    );
  if (g.coverageSources.length) {
    const shown = g.coverageSources.slice(0, 4);
    const more = g.coverageSources.length - shown.length;
    lines.push(`Nguồn: ${esc(shown.join(", "))}${more > 0 ? ` +${more}` : ""}`);
  }
  return lines.join("\n");
}

/** The run's most important change group as a standalone alert —
 *  same anatomy as formatBreaking but headed "important change"
 *  rather than "new event". */
function formatTopChange(
  g: {
    eventId?: string;
    eventTitle: string;
    substantive: ChangeLike[];
    coverageSources: string[];
  },
  siteUrl: string | undefined,
): string {
  const lines = ["⚡ <b>THAY ĐỔI QUAN TRỌNG</b>", "", titleHtml(siteUrl, g)];
  const top = g.substantive
    .filter((c) => !isNewEvent(c.type))
    .sort(
      (a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9),
    );
  for (const c of top.slice(0, MAX_LINES_PER_EVENT)) {
    const label = CHANGE_LABEL[c.type] ?? c.type;
    lines.push(`• ${label} — ${esc(changeSummaryText(c, label))}`);
  }
  if (top.length > MAX_LINES_PER_EVENT)
    lines.push(`• …${top.length - MAX_LINES_PER_EVENT} dữ kiện khác trên app`);
  if (g.coverageSources.length) {
    const shown = g.coverageSources.slice(0, 4);
    const more = g.coverageSources.length - shown.length;
    lines.push(`Nguồn: ${esc(shown.join(", "))}${more > 0 ? ` +${more}` : ""}`);
  }
  return lines.join("\n");
}

/** One message per run: the top-ranked event group (materiality, then
 *  recency — the same ordering the web rail uses) is the alert; every
 *  other changed event collapses into a single footer line so the push
 *  budget is exactly one interruption no matter how busy the run was. */
export function formatAlertMessages(
  changes: DigestChange[],
  siteUrl?: string,
): string[] {
  const deduped = dedupChanges(changes);
  if (deduped.length === 0) return [];

  const [top, ...rest] = groupChangesByEvent(deduped);
  let msg = top.substantive.some((c) => isNewEvent(c.type))
    ? formatBreaking(top, siteUrl)
    : formatTopChange(top, siteUrl);
  if (rest.length) {
    const more = siteUrl
      ? `<a href="${siteUrl}">xem trên ThunderFeed</a>`
      : "xem trên app";
    msg += `\n…và ${rest.length} sự kiện khác — ${more}`;
  }
  return [msg];
}
