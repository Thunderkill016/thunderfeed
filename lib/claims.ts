/**
 * Claim-level analysis — the layer no consumer news product has.
 *
 * For each displayed cluster we ask Gemini for a structured matrix:
 *   consensus — factual points ≥2 sources state
 *   disputes  — topics where sources assert materially different things
 *
 * The model only ever sees the cluster's own headlines/summaries, and the
 * output is validated mechanically before it can reach the UI: every named
 * source must be a real cluster source and every number must already exist
 * in the cluster corpus. Anything else is dropped wholesale (fail-closed),
 * so a hallucinated claim can never ship as product content.
 */

import type { ClaimAnalysis, ClaimDispute, StoryCluster } from "./model";
import { extractNumbers, geminiModel } from "./gemini";
import { normalizeText } from "./model";
import type { ExtractedClaim } from "./db/writer";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const CALL_TIMEOUT = 15_000;

const MAX_CONSENSUS = 6;
const MAX_DISPUTES = 4;
const MAX_POSITIONS = 6;
const MAX_TEXT_LEN = 220;

/** Per-source evidence text shown to the model — titles + summaries only. */
function corpusFor(cluster: StoryCluster): string {
  return cluster.articles
    .slice(0, 10)
    .map(
      (a) =>
        `[${a.source}] ${a.title}${a.summary ? ` — ${a.summary.slice(0, 260)}` : ""}`,
    )
    .join("\n");
}

function buildPrompt(cluster: StoryCluster): string {
  return [
    "Bạn là máy phân tích dữ kiện báo chí. Dưới đây là giật tít và tóm tắt của các nguồn đưa tin về CÙNG một sự kiện.",
    "",
    "Nhiệm vụ: trích ma trận dữ kiện.",
    '- "consensus": các dữ kiện mà TỐI THIỂU 2 nguồn cùng nêu (tối đa 6 mục).',
    '- "disputes": các điểm nguồn này nói khác nguồn kia — khác con số, khác kết luận, khác cách gọi/diễn giải (tối đa 4 mục, mỗi mục ≥2 nguồn).',
    "",
    "Quy tắc:",
    "- Chỉ dùng thông tin trong các đoạn trích; không suy diễn thêm, không thêm con số nào không có sẵn.",
    "- Tên nguồn phải khớp nguyên văn tên trong ngoặc vuông.",
    '- Viết ngắn gọn bằng tiếng Việt; mỗi "point"/"claim" ≤ 160 ký tự.',
    '- Chỉ trả JSON hợp lệ: {"consensus":[{"point":"…","sources":["…","…"]}],"disputes":[{"topic":"…","positions":[{"source":"…","claim":"…"}]}]}. Nếu không có disputes thì trả mảng rỗng.',
    "",
    "Các đoạn trích:",
    corpusFor(cluster),
  ].join("\n");
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Mechanical grounding gate. Returns a sanitized ClaimAnalysis or null.
 * Rules: known sources only, numbers must exist in the corpus, sane
 * cardinalities, disputes need ≥2 distinct sources.
 */
export function validateClaims(
  raw: unknown,
  sourceNames: Set<string>,
  allowedNumbers: Set<number>,
): ClaimAnalysis | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.consensus) || !Array.isArray(obj.disputes))
    return null;

  // LLMs casually drop diacritics — resolve "Tuoi Tre" back to "Tuổi Trẻ"
  const canon = new Map<string, string>();
  for (const s of sourceNames) canon.set(normalizeText(s), s);
  const resolve = (s: string): string | null =>
    sourceNames.has(s) ? s : (canon.get(normalizeText(s)) ?? null);

  const grounded = (s: string) =>
    s.length <= MAX_TEXT_LEN &&
    extractNumbers(s).every((n) => allowedNumbers.has(n));

  const consensus = obj.consensus
    .slice(0, MAX_CONSENSUS)
    .map((c): { point: string; sources: string[] } | null => {
      if (typeof c !== "object" || c === null) return null;
      const { point, sources } = c as Record<string, unknown>;
      if (!isStr(point) || !grounded(point.trim())) return null;
      if (!Array.isArray(sources)) return null;
      const srcs = sources
        .filter(isStr)
        .map((s) => resolve(s.trim()))
        .filter((s): s is string => s !== null);
      if (new Set(srcs).size < 2) return null;
      return { point: point.trim(), sources: [...new Set(srcs)] };
    })
    .filter((c): c is { point: string; sources: string[] } => c !== null);

  const disputes: ClaimDispute[] = obj.disputes
    .slice(0, MAX_DISPUTES)
    .map((d): ClaimDispute | null => {
      if (typeof d !== "object" || d === null) return null;
      const { topic, positions } = d as Record<string, unknown>;
      if (!isStr(topic) || !grounded(topic.trim())) return null;
      if (!Array.isArray(positions)) return null;
      const pos = positions
        .slice(0, MAX_POSITIONS)
        .map((p): { source: string; claim: string } | null => {
          if (typeof p !== "object" || p === null) return null;
          const { source, claim } = p as Record<string, unknown>;
          const resolved = isStr(source) ? resolve(source.trim()) : null;
          if (!resolved) return null;
          if (!isStr(claim) || !grounded(claim.trim())) return null;
          return { source: resolved, claim: claim.trim() };
        })
        .filter((p): p is { source: string; claim: string } => p !== null);
      if (new Set(pos.map((p) => p.source)).size < 2) return null;
      return { topic: topic.trim(), positions: pos };
    })
    .filter((d): d is ClaimDispute => d !== null);

  if (!consensus.length && !disputes.length) return null;
  return { consensus, disputes, origin: "gemini", model: geminiModel() };
}

export async function generateClaims(
  apiKey: string,
  cluster: StoryCluster,
): Promise<ClaimAnalysis | null> {
  if (cluster.sources.length < 2) return null;
  const sourceNames = new Set(cluster.sources.map((s) => s.name));
  const allowedNumbers = new Set(
    extractNumbers(`${cluster.title} ${cluster.summary} ${corpusFor(cluster)}`),
  );
  const model = geminiModel();
  const body = {
    contents: [{ parts: [{ text: buildPrompt(cluster) }] }],
    generationConfig: {
      temperature: 0.1,
      // thinking-model output budget: reasoning burns tokens before the JSON
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
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
    const data = (await res.json()) as {
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string; thought?: boolean }[] };
      }[];
    };
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP")
      return null;
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return validateClaims(parsed, sourceNames, allowedNumbers);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
 * Canonical claim extraction — the LLM sibling of lib/db/extract.ts.
 * Both write the same Claim/ClaimEvidence tables; this one catches
 * non-numeric facts ("OpenAI phát hành model X", "chính phủ thông qua
 * chính sách Y") that the deterministic patterns cannot see.
 * ------------------------------------------------------------------ */

const MAX_LLM_CLAIMS = 8;
const LLM_STATES = new Set([
  "reported",
  "confirmed",
  "disputed",
  "corrected",
  "retracted",
]);

function buildExtractPrompt(cluster: StoryCluster): string {
  return [
    "Bạn là máy trích dữ kiện. Dưới đây là giật tít/tóm tắt của các nguồn đưa tin về CÙNG một sự kiện.",
    "",
    "Nhiệm vụ: với MỖI nguồn, trích các dữ kiện nó khẳng định, dạng cấu trúc.",
    'Mỗi claim: {"subject":"chủ thể","predicate":"điều được khẳng định","value":"giá trị","unit":"đơn vị hoặc null","label":"cụm từ nguyên văn ngắn","source":"tên nguồn trong ngoặc vuông"}',
    "",
    "Quy tắc:",
    "- subject: thực thể chính (cơ quan, công ty, địa danh); để trống nếu không rõ.",
    "- predicate: danh từ/khái niệm chuẩn hóa, ví dụ: flights_cancelled, deaths, interest_rate, product_launch, policy_approved, arrest, price.",
    "- value: giá trị ngắn gọn (số, tên, mô tả ngắn ≤ 80 ký tự). Chỉ dùng nội dung CÓ TRONG đoạn trích — không suy diễn, không thêm con số mới.",
    "- Chỉ trích dữ kiện KHẲNG ĐỊNH được (không trích ý kiến, bình luận, phỏng đoán).",
    "- BỎ QUA dữ kiện nghi thức/hình thức không đổi thực trạng sự kiện: trang phục, bữa ăn, lễ đón, bắt tay, chụp ảnh, thảm đỏ, sắp xếp hội nghị.",
    "- Ưu tiên dữ kiện đổi trạng thái thật: con số, quyết định, hành động, tuyên bố, hậu quả.",
    "- Tối đa 8 claim tổng cộng, ưu tiên dữ kiện xuất hiện ở nhiều nguồn.",
    '- Chỉ trả JSON hợp lệ: {"claims":[...]}. Không có gì thì {"claims":[]}.',
    "",
    "Các đoạn trích:",
    corpusFor(cluster),
  ].join("\n");
}

const slug = (s: string) =>
  normalizeText(s)
    .replace(/[^a-z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_");

/**
 * Salience gate for model-extracted claims. The LLM faithfully extracts
 * whatever reporters mention — including protocol trivia ("ăn trưa làm
 * việc", "trang phục tông xám") that must never page the alert channel.
 * Deterministic numeric claims are always "core" — a hard number is a
 * diff target by construction.
 */
const PERIPHERAL_RE =
  /(ăn (trưa|tối|sáng)|tiệc\b|chiêu đãi|trang phục|đeo găng|găng tay|thảm đỏ|bắt tay|lễ đón|phu nhân|tông màu|tặng hoa|chụp ảnh|sân bay tân sơn nhất|nội các|hội nghị ban chỉ đạo|khai mạc|bế mạc|dự lễ|lunch|dinner|banquet|outfit|handshake|red carpet|photo op|welcoming ceremony|gala|first lady|spouse|wearing|wore)/i;

export function claimSalience(
  claim: Pick<ExtractedClaim, "predicate" | "label" | "valueType">,
): "core" | "peripheral" {
  if (claim.valueType === "number" || claim.valueType === "range")
    return "core";
  return PERIPHERAL_RE.test(`${claim.predicate} ${claim.label}`)
    ? "peripheral"
    : "core";
}

/**
 * Validate + normalize LLM-extracted claims into ExtractedClaim[].
 * Grounding gate (fail-closed): source must be a real cluster source;
 * numeric values must already exist in the corpus; predicate/subject
 * slugged into the same claim_key space as the deterministic extractor.
 */
export function validateExtractedClaims(
  raw: unknown,
  cluster: StoryCluster,
): ExtractedClaim[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as Record<string, unknown>).claims;
  if (!Array.isArray(list)) return [];

  const sourceNames = new Set(cluster.sources.map((s) => s.name));
  const canon = new Map<string, string>();
  for (const s of sourceNames) canon.set(normalizeText(s), s);
  const allowedNumbers = new Set(
    extractNumbers(`${cluster.title} ${cluster.summary} ${corpusFor(cluster)}`),
  );
  const resolve = (s: string): string | null =>
    sourceNames.has(s) ? s : (canon.get(normalizeText(s)) ?? null);

  const out: ExtractedClaim[] = [];
  for (const item of list.slice(0, MAX_LLM_CLAIMS)) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const source = isStr(c.source) ? resolve(c.source.trim()) : null;
    const predicate = isStr(c.predicate) ? slug(c.predicate) : "";
    const label = isStr(c.label) ? c.label.trim() : "";
    if (!source || !predicate || !label || label.length > MAX_TEXT_LEN)
      continue;

    const subject = isStr(c.subject) ? c.subject.trim() : "";
    const rawValue = c.value;
    const value =
      typeof rawValue === "number"
        ? rawValue
        : isStr(rawValue)
          ? rawValue.trim().slice(0, 160)
          : "";
    if (value === "" || value === null) continue;
    // numbers must exist in the corpus — same gate as the UI matrix
    if (extractNumbers(String(value)).some((n) => !allowedNumbers.has(n)))
      continue;

    const claimKey = subject ? `${slug(subject)}|${predicate}` : predicate;
    // the article asserting it — best-effort match on the source's docs
    const article =
      cluster.articles.find(
        (a) =>
          a.source === source &&
          `${a.title} ${a.summary}`.includes(
            typeof value === "number" ? String(value) : label.slice(0, 24),
          ),
      ) ?? cluster.articles.find((a) => a.source === source);

    const state =
      isStr(c.state) && LLM_STATES.has(c.state) ? c.state : undefined;
    out.push({
      claimKey,
      predicate,
      claimType: "fact",
      valueType: typeof value === "number" ? "number" : "text",
      value,
      unit: isStr(c.unit) ? c.unit.trim() : undefined,
      qualifiers: subject ? { subject } : undefined,
      state: state as ExtractedClaim["state"],
      label,
      assertedBy: source,
      articleId: article?.id,
      method: "model",
      salience: claimSalience({
        predicate,
        label,
        valueType: typeof value === "number" ? "number" : "text",
      }),
    });
  }
  return out;
}

/** Gemini structured-claim pass for one cluster. Fail-closed: []. */
export async function extractClaimsLLM(
  apiKey: string,
  cluster: StoryCluster,
): Promise<ExtractedClaim[]> {
  const model = geminiModel();
  const body = {
    contents: [{ parts: [{ text: buildExtractPrompt(cluster) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
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
    if (!res.ok) return [];
    const data = (await res.json()) as {
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string; thought?: boolean }[] };
      }[];
    };
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP") return [];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return validateExtractedClaims(parsed, cluster);
  } catch {
    return [];
  }
}
