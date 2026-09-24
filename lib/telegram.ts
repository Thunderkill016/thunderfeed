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
  eventId?: string;
  eventTitle: string;
  type: string;
  materiality: string;
  summary: string;
  detectedAt: string;
}

const MAT_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
/** grouped digest budget — beyond this, overflow becomes a footer line */
const MAX_LINES = 24;
/** change types that mean "another source confirmed" — collapse into one
 *  line per event instead of one line per source */
const COVERAGE_TYPES = new Set(["new_independent_evidence", "new_coverage"]);

/** One alert per message when few; a per-event grouped digest when many.
 *  Distinct change rows can carry identical (event, type, summary) — e.g.
 *  several evidence versions of the same article — so lines are deduped on
 *  that triple first. Coverage-type changes collapse to "N nguồn: A, B". */
export function formatAlertMessages(changes: DigestChange[]): string[] {
  const deduped: DigestChange[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const k = `${c.eventId ?? c.eventTitle}|${c.type}|${c.summary}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(c);
  }
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

  // group by event — one block per event, coverage collapsed
  const groups = new Map<
    string,
    { title: string; items: DigestChange[]; rank: number; latest: number }
  >();
  for (const c of deduped) {
    const key = c.eventId ?? c.eventTitle;
    let g = groups.get(key);
    if (!g) {
      g = { title: c.eventTitle, items: [], rank: 9, latest: 0 };
      groups.set(key, g);
    }
    g.items.push(c);
    g.rank = Math.min(g.rank, MAT_ORDER[c.materiality] ?? 1);
    g.latest = Math.max(g.latest, Date.parse(c.detectedAt) || 0);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.rank - b.rank || b.latest - a.latest,
  );

  const lines: string[] = [];
  let skippedEvents = 0;
  for (const g of ordered) {
    const block = [`▸ ${g.title}`];
    const coverage: string[] = [];
    for (const c of g.items) {
      if (COVERAGE_TYPES.has(c.type)) {
        // "…xác nhận: Source" / "…đưa tin: Source" — keep the source name
        const m = c.summary.match(/:\s*([^:]+)$/);
        coverage.push(m?.[1]?.trim() ?? c.summary);
      } else {
        const label = CHANGE_LABEL[c.type] ?? c.type;
        // writer already prefixes some summaries with the same label —
        // "Dữ kiện mới: 519 triệu USD" — don't double it
        const summary = c.summary.startsWith(`${label}:`)
          ? c.summary.slice(label.length + 1).trim()
          : c.summary;
        block.push(`  • ${label}: ${summary}`);
      }
    }
    if (coverage.length)
      block.push(`  • ${coverage.length} nguồn: ${coverage.join(", ")}`);
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
