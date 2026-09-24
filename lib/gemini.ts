/**
 * Optional Gemini adapter — nhận định generated ONLY from extracted cluster
 * facts. This layer never creates or verifies facts: it is a bounded renderer
 * over the deterministic pipeline's output. Grounding is enforced
 * mechanically — any digit token in the output that cannot be traced to a
 * supplied fact causes the assessment to be dropped entirely (fail-closed).
 * Without GEMINI_API_KEY, or on any HTTP/parse/validation failure, the caller
 * falls back to the deterministic nhận định. Ported from diem-tin.
 */

import type { NhanDinh, StoryCluster } from "./model";

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
}

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiEnabled(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/* ------------------------- grounding validation ------------------------- */

/** Digit tokens (incl. grouped/decimal forms) appearing in a text. */
export function extractNumbers(text: string): number[] {
  const tokens = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return tokens.map(numberFromToken).filter(Number.isFinite);
}

/**
 * A separator is a thousands group iff it is followed by exactly 3 digits
 * (so both "1,250" en and "1.250" vi parse to 1250); otherwise decimal.
 */
function numberFromToken(token: string): number {
  const last = token.match(/[.,](\d+)$/);
  if (last !== null && last[1].length === 3)
    return Number(token.replace(/[.,]/g, ""));
  return Number(token.replace(/,/g, "."));
}

/** Phrases that would turn a nhận định into advice — always rejected. */
const ADVICE_PATTERNS = [
  /nên\s+(mua|bán|giữ|đầu tư)/i,
  /khuyến nghị/i,
  /điểm (mua|bán|chốt)/i,
  /dự báo giá/i,
];

const MIN_LEN = 60;
const MAX_LEN = 1400;

/**
 * A nhận định is grounded iff sane length, no advice, and every numeric token
 * already appears (by value) in the fact set.
 */
export function isGroundedNhanDinh(
  text: string,
  allowedNumbers: Set<number>,
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return false;
  if (ADVICE_PATTERNS.some((p) => p.test(trimmed))) return false;
  if (/[*_`#]/.test(trimmed)) return false;
  if (/^(dưới đây|sau đây|tóm tắt|theo yêu cầu)/i.test(trimmed)) return false;
  return extractNumbers(trimmed).every((n) => allowedNumbers.has(n));
}

/* ----------------------------- prompt builder ---------------------------- */

function buildClusterFacts(cluster: StoryCluster): string[] {
  const facts: string[] = [];
  const lead = cluster.leadArticle;
  facts.push(`Sự kiện chính: ${lead.title}`);
  if (lead.summary)
    facts.push(`Tóm tắt nguồn dẫn (${lead.source}): ${lead.summary}`);
  for (const s of cluster.sources.slice(1, 6)) {
    if (s.angle) facts.push(`Giật tít của ${s.name}: ${s.angle}`);
  }
  if (cluster.mediaSpectrum) {
    const m = cluster.mediaSpectrum;
    facts.push(
      `Độ phủ: ${m.totalSources} tòa soạn, trong nước ${m.domesticCount}, quốc tế ${m.internationalCount}.`,
    );
  }
  return facts;
}

export function buildNhanDinhPrompt(cluster: StoryCluster): string {
  return [
    "Bạn là chuyên gia phân tích tin tức. Dưới đây là các dữ kiện đã trích xuất về một sự kiện được nhiều báo đưa tin.",
    "Viết phần NHẬN ĐỊNH 2–4 câu bằng tiếng Việt: đánh giá vì sao sự kiện đáng chú ý, mức độ phủ và sự khác biệt framing giữa các nguồn nếu có.",
    "",
    "Quy tắc bắt buộc:",
    "- Chỉ dùng thông tin trong các dữ kiện liệt kê; không thêm con số, sự kiện hay quan hệ nhân quả nào khác.",
    "- Không khuyến nghị mua/bán, không dự đoán giá, không tiên đoán kết quả chắc chắn — khi suy luận thì đặt điều kiện rõ ràng ('nếu xu hướng này kéo dài…').",
    "- Chỉ trả về nội dung nhận định; không lời dẫn kiểu 'Dưới đây là…', không markdown.",
    "- Văn phong trung lập, giàu thông tin, kiểu nhà phân tích.",
    "",
    "Dữ kiện:",
    ...buildClusterFacts(cluster).map((f) => `- ${f}`),
  ].join("\n");
}

/* ------------------------------- API call -------------------------------- */

type GeminiResponse = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
};

const CALL_TIMEOUT = 12_000;

export async function generateNhanDinh(
  apiKey: string,
  cluster: StoryCluster,
): Promise<NhanDinh | null> {
  const facts = buildClusterFacts(cluster);
  const allowed = new Set(facts.flatMap((f) => extractNumbers(f)));
  const model = geminiModel();
  const body = {
    contents: [{ parts: [{ text: buildNhanDinhPrompt(cluster) }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 700,
    },
  };

  try {
    const res = await fetch(
      `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      return null;
    }
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!isGroundedNhanDinh(text, allowed)) return null;
    return { text, watchItems: [], origin: "gemini", model };
  } catch {
    return null;
  }
}
