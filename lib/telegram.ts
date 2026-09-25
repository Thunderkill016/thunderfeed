/**
 * Telegram delivery — Bot API client for the alert layer. Token/chat id
 * come from env only (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); nothing is
 * persisted.
 *
 * Design (Ground News / Kagi-style): push is an interruption budget.
 * Two lanes — BREAKING (a new important event gets its own message,
 * self-contained with a deep link) and DIGEST (the rest of the run's
 * material deltas grouped per event). Messages are HTML parse_mode:
 * titles render bold + link back to the event page; all source text is
 * escaped so arbitrary summaries can't break markup.
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

/** grouped digest budget — beyond this, overflow becomes a footer line */
const MAX_LINES = 24;
/** substantive lines shown per event — a push digest reads top-facts,
 *  not the full claim diff; the rest stay on the event page */
const MAX_LINES_PER_EVENT = 3;
/** breaking messages per run — beyond this, new events fold into digest */
const MAX_BREAKING = 5;
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

/** BREAKING lane for new events (already importance-gated upstream),
 *  DIGEST for the rest — grouped per event, claims ranked by severity. */
export function formatAlertMessages(
  changes: DigestChange[],
  siteUrl?: string,
): string[] {
  const deduped = dedupChanges(changes);
  if (deduped.length === 0) return [];

  const ordered = groupChangesByEvent(deduped);
  const breaking: string[] = [];
  const digestGroups: typeof ordered = [];
  for (const g of ordered) {
    if (
      g.substantive.some((c) => isNewEvent(c.type)) &&
      breaking.length < MAX_BREAKING
    ) {
      breaking.push(formatBreaking(g, siteUrl));
    } else {
      digestGroups.push(g);
    }
  }

  const messages: string[] = [...breaking];
  if (!digestGroups.length) return messages;

  const lines: string[] = [];
  let skippedEvents = 0;
  for (const g of digestGroups) {
    const isNew = g.substantive.some((c) => isNewEvent(c.type));
    const head = g.eventId
      ? { eventId: g.eventId, eventTitle: g.eventTitle }
      : { eventTitle: g.eventTitle };
    const block = [`▸ ${isNew ? "🆕 " : ""}${titleHtml(siteUrl, head)}`];
    const top = g.substantive
      .filter((c) => !isNewEvent(c.type))
      .sort(
        (a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9),
      );
    for (const c of top.slice(0, MAX_LINES_PER_EVENT)) {
      const label = CHANGE_LABEL[c.type] ?? c.type;
      block.push(`  • ${label} — ${esc(changeSummaryText(c, label))}`);
    }
    if (top.length > MAX_LINES_PER_EVENT)
      block.push(
        `  • …${top.length - MAX_LINES_PER_EVENT} dữ kiện khác trên app`,
      );
    if (g.coverageSources.length)
      block.push(
        `  • ${g.coverageSources.length} nguồn: ${esc(g.coverageSources.join(", "))}`,
      );
    if (lines.length + block.length > MAX_LINES) {
      skippedEvents++;
      continue;
    }
    lines.push(...block);
  }
  if (skippedEvents) lines.push(`…và ${skippedEvents} sự kiện khác trên app`);

  const header = `⚡ <b>ThunderFeed</b> — ${digestGroups.length} sự kiện có thay đổi\n`;
  let cur = header;
  for (const l of lines) {
    if (cur.length + l.length + 1 > MSG_LIMIT - 100) {
      messages.push(cur);
      cur = "";
    }
    cur += (cur.endsWith("\n") || cur === "" ? "" : "\n") + l + "\n";
  }
  if (cur.trim()) messages.push(cur);
  return messages;
}
