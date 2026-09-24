/**
 * Telegram delivery — Bot API client for the alert layer. Token/chat id
 * come from env only (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); nothing is
 * persisted. Messages are plain text (no parse_mode) so summaries can't
 * break formatting with stray HTML/markdown chars.
 */

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

interface DigestChange {
  eventTitle: string;
  type: string;
  materiality: string;
  summary: string;
  detectedAt: string;
}

/** One alert per message when few; a compact digest when many.
 *  Distinct change rows can carry identical (event, type, summary) — e.g.
 *  several evidence versions of the same article — so digest lines are
 *  deduped on that triple. */
export function formatAlertMessages(changes: DigestChange[]): string[] {
  const deduped: DigestChange[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const k = `${c.eventTitle}|${c.type}|${c.summary}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(c);
  }
  if (deduped.length === 0) return [];
  if (deduped.length <= 3) {
    return deduped.map(
      (c) =>
        `⚡ ${CHANGE_LABEL[c.type] ?? c.type} [${c.materiality}]\n` +
        `${c.eventTitle}\n${c.summary}`,
    );
  }
  const header = `⚡ ThunderFeed — ${deduped.length} thay đổi đáng chú ý\n`;
  const lines = deduped.map(
    (c) =>
      `• [${CHANGE_LABEL[c.type] ?? c.type}] ${c.eventTitle}\n  ${c.summary}`,
  );
  // chunk into MSG_LIMIT-sized messages
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
