/**
 * Telegram delivery — Bot API client for the alert layer. Token/chat id
 * come from env only (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); nothing is
 * persisted. Messages are plain text (no parse_mode) so summaries can't
 * break formatting with stray HTML/markdown chars.
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

/** One alert per message when few; a per-event grouped digest when many.
 *  Dedup + grouping live in lib/changes.ts — shared with the web rail so
 *  coverage collapses to "N nguồn: A, B" on every surface. */
export function formatAlertMessages(changes: DigestChange[]): string[] {
  const deduped = dedupChanges(changes);
  if (deduped.length === 0) return [];

  const distinctEvents = new Set(deduped.map((c) => c.eventId ?? c.eventTitle))
    .size;
  if (deduped.length <= 3 && deduped.length === distinctEvents) {
    return deduped.map(
      (c) =>
        `⚡ ${CHANGE_LABEL[c.type] ?? c.type} [${c.materiality}]\n` +
        `${c.eventTitle}\n${c.summary}`,
    );
  }

  const ordered = groupChangesByEvent(deduped);
  const lines: string[] = [];
  let skippedEvents = 0;
  for (const g of ordered) {
    const block = [`▸ ${g.eventTitle}`];
    for (const c of g.substantive) {
      const label = CHANGE_LABEL[c.type] ?? c.type;
      block.push(`  • ${label}: ${changeSummaryText(c, label)}`);
    }
    if (g.coverageSources.length)
      block.push(
        `  • ${g.coverageSources.length} nguồn: ${g.coverageSources.join(", ")}`,
      );
    if (lines.length + block.length > MAX_LINES) {
      skippedEvents++;
      continue;
    }
    lines.push(...block);
  }
  if (skippedEvents) lines.push(`…và ${skippedEvents} sự kiện khác trên app`);

  const header = `⚡ ThunderFeed — ${ordered.length} sự kiện có thay đổi\n`;
  const out: string[] = [];
  let cur = header;
  for (const l of lines) {
    if (cur.length + l.length + 1 > MSG_LIMIT - 100) {
      out.push(cur);
      cur = "";
    }
    cur += (cur.endsWith("\n") || cur === "" ? "" : "\n") + l + "\n";
  }
  if (cur.trim()) out.push(cur);
  return out;
}
