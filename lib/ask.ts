/**
 * Ask — grounded Q&A over canonical event state. The model only ever sees
 * facts extracted from EventViews (claims, changes, confidence); grounding
 * is enforced mechanically the same way as nhận định — every digit token in
 * the answer must trace to a supplied fact, or the answer is dropped
 * (fail-closed → deterministic extractive answer).
 */

import type { EventView } from "./db/read";
import { getEventView, searchEvents } from "./db/read";
import { extractNumbers, geminiEnabled, geminiModel } from "./gemini";
import { fmtClaimValue, PRED_LABEL_VI } from "./format";

export interface AskResult {
  question: string;
  answer: string;
  origin: "gemini" | "extractive";
  events: {
    id: string;
    title: string;
    status: string;
    confidence: string;
  }[];
}

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const CALL_TIMEOUT = 12_000;

const STATE_LABEL: Record<string, string> = {
  reported: "đang đưa",
  confirmed: "đã xác nhận",
  disputed: "đang tranh chấp",
  corrected: "đã chỉnh sửa",
  retracted: "đã rút lại",
};

const fmtValue = fmtClaimValue;

/** Facts per event — the ONLY information the model is allowed to use. */
function buildEventFacts(view: EventView): string[] {
  const facts: string[] = [];
  facts.push(`Sự kiện: ${view.title}`);
  facts.push(`Tóm tắt chuẩn: ${view.summary}`);
  facts.push(
    `Trạng thái: ${view.status}; độ tin cậy: ${view.confidence.state}; ` +
      `${view.confidence.confirmedIndependentOrigins} nguồn gốc độc lập đã xác nhận.`,
  );
  for (const c of view.claims.slice(0, 8)) {
    const positions =
      c.positions && c.positions.length > 1
        ? ` — các vị thế: ${c.positions
            .map(
              (p) => `${fmtValue(p.value, c.unit)} (${p.sources.join(", ")})`,
            )
            .join("; ")}`
        : "";
    facts.push(
      `Dữ kiện "${PRED_LABEL_VI[c.predicate] ?? c.predicate}": ${fmtValue(c.value, c.unit)} — ` +
        `${STATE_LABEL[c.state] ?? c.state}, ${c.evidenceCount} bằng chứng${positions}.`,
    );
  }
  for (const ch of view.latestChanges.slice(0, 4)) {
    facts.push(`Diễn biến: ${ch.summary} (${ch.detectedAt})`);
  }
  return facts;
}

function buildAskPrompt(question: string, views: EventView[]): string {
  const facts = views.flatMap((v, i) =>
    buildEventFacts(v).map((f) => `[Sự kiện ${i + 1}] ${f}`),
  );
  return [
    "Bạn là chuyên gia phân tích tin tức. Trả lời câu hỏi của độc giả CHỈ dựa trên các dữ kiện đã liệt kê về trạng thái chuẩn của các sự kiện liên quan.",
    "",
    "Quy tắc bắt buộc:",
    "- Chỉ dùng thông tin trong các dữ kiện liệt kê; không thêm con số, sự kiện hay quan hệ nhân quả nào khác.",
    "- Khi dữ kiện mâu thuẫn hoặc chưa xác nhận, nói rõ mức độ chắc chắn thay vì khẳng định.",
    "- Nêu sự kiện nào thông tin đến từ đâu, vd: 'theo sự kiện 1…'.",
    "- Không khuyến nghị, không dự đoán chắc chắn.",
    "- Trả lời 2–5 câu bằng tiếng Việt; không lời dẫn, không markdown.",
    "- Nếu dữ kiện không đủ để trả lời, trả lời đúng một câu: 'Dữ kiện hiện có chưa đủ để trả lời câu hỏi này.'",
    "",
    `Câu hỏi: ${question}`,
    "",
    "Dữ kiện:",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

/* ---------------------------- grounding check ---------------------------- */

const ADVICE_PATTERNS = [
  /nên\s+(mua|bán|giữ|đầu tư)/i,
  /khuyến nghị/i,
  /dự báo giá/i,
];

const INSUFFICIENT = /dữ kiện hiện có chưa đủ/i;

export function isGroundedAnswer(
  text: string,
  allowedNumbers: Set<number>,
): boolean {
  const t = text.trim();
  if (t.length < 20 || t.length > 2000) return false;
  if (INSUFFICIENT.test(t)) return true; // abstention is always grounded
  if (ADVICE_PATTERNS.some((p) => p.test(t))) return false;
  if (/[*_`#]/.test(t)) return false;
  return extractNumbers(t).every((n) => allowedNumbers.has(n));
}

/* ------------------------------ generation ------------------------------- */

type GeminiResponse = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
};

async function generateAnswer(
  apiKey: string,
  question: string,
  views: EventView[],
): Promise<string | null> {
  const facts = views.flatMap(buildEventFacts);
  const allowed = new Set(facts.flatMap((f) => extractNumbers(f)));
  // "[Sự kiện N]" markers are fact scaffolding — the prompt tells the model
  // to cite them, so ordinals are always traceable numbers
  views.forEach((_, i) => allowed.add(i + 1));
  const model = geminiModel();
  try {
    const res = await fetch(
      `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildAskPrompt(question, views) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP")
      return null;
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    return isGroundedAnswer(text, allowed) ? text : null;
  } catch {
    return null;
  }
}

/* --------------------------- extractive fallback -------------------------- */

/** Deterministic answer from canonical state — no model, always grounded. */
function extractiveAnswer(views: EventView[]): string {
  if (views.length === 0)
    return "Không tìm thấy sự kiện nào khớp câu hỏi trong dữ liệu hiện có.";
  const top = views[0];
  const confirmed = top.claims.filter((c) => c.state === "confirmed");
  const disputed = top.claims.filter((c) => c.state === "disputed");
  /* free-text predicates carry no VI label — for text-valued claims the
   * value IS the claim sentence; snake_case keys are never shown */
  const claimLabel = (c: (typeof top.claims)[number]): string =>
    typeof c.value === "string"
      ? c.value
      : `${PRED_LABEL_VI[c.predicate] ?? c.predicate.replace(/_/g, " ")} = ${fmtValue(c.value, c.unit)}`;
  const parts: string[] = [];
  parts.push(
    `Sự kiện liên quan nhất: "${top.title}" (${STATE_LABEL[top.status] ?? top.status}, độ tin cậy ${top.confidence.state}).`,
  );
  if (confirmed.length)
    parts.push(
      `Dữ kiện đã xác nhận: ${confirmed
        .slice(0, 3)
        .map(claimLabel)
        .join("; ")}.`,
    );
  if (disputed.length)
    parts.push(
      `Đang tranh chấp: ${disputed
        .slice(0, 2)
        .map(claimLabel)
        .join("; ")} — các nguồn đưa giá trị khác nhau.`,
    );
  if (views.length > 1)
    parts.push(`Còn ${views.length - 1} sự kiện liên quan khác.`);
  return parts.join(" ");
}

/* ------------------------------- entry point ------------------------------ */

export async function answerQuestion(question: string): Promise<AskResult> {
  const hits = await searchEvents(question);
  const views = (
    await Promise.all(hits.slice(0, 4).map((h) => getEventView(h.id)))
  ).filter((v): v is EventView => !!v);

  const apiKey = process.env.GEMINI_API_KEY;
  let answer: string | null = null;
  let origin: AskResult["origin"] = "extractive";
  if (views.length && apiKey && geminiEnabled()) {
    answer = await generateAnswer(apiKey, question, views);
    if (answer) origin = "gemini";
  }
  answer ??= extractiveAnswer(views);

  return {
    question,
    answer,
    origin,
    events: views.map((v) => ({
      id: v.id,
      title: v.title,
      status: v.status,
      confidence: v.confidence.state,
    })),
  };
}
