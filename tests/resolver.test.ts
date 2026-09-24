/**
 * Event-resolver regression tests distilled from the labeled real-corpus
 * benchmark (bench/pairs.jsonl). Each case is a failure mode the 495-pair
 * corpus exposed; the test pins the invariant so tuning cannot silently
 * reopen it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool } from "../lib/db/pool";
import { persistCluster } from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import type { Article, StoryCluster } from "../lib/model";

function setupDb() {
  const db = newDb();
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n")
    .replace(
      /CREATE OR REPLACE FUNCTION uuid_v7[\s\S]*?LANGUAGE plpgsql VOLATILE;/,
      "",
    )
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/g, "");
  db.public.registerFunction({
    name: "uuid_v7",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  db.public.none(sql);
  const pg = db.adapters.createPg();
  injectPool(new pg.Pool() as unknown as Pool);
}

function cluster(
  title: string,
  opts: {
    summary?: string;
    language?: "vi" | "en";
    source?: string;
    publishedAt?: string;
  } = {},
): StoryCluster {
  const a: Article = {
    id: randomUUID(),
    title,
    summary: opts.summary ?? "",
    url: `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: opts.publishedAt ?? new Date().toISOString(),
    source: opts.source ?? "VnExpress",
    topic: "world",
    headline: false,
    appearances: [],
    language: opts.language ?? "vi",
  };
  return {
    id: `rc-${randomUUID().slice(0, 8)}`,
    title,
    summary: a.summary,
    leadArticle: a,
    articles: [a],
    sources: [{ name: a.source, url: a.url }],
    topic: "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: a.publishedAt,
  };
}

async function sameEvent(a: StoryCluster, b: StoryCluster): Promise<boolean> {
  const ra = await persistCluster(a, extractClaims(a));
  const rb = await persistCluster(b, extractClaims(b));
  return ra.eventId === rb.eventId;
}

/* ------------------------- must NOT merge (wrong-merge traps) --------------- */

test("summary entity contamination: two Trung Thu charity events stay split", async () => {
  setupDb();
  // both summaries reference the same boilerplate places (danang/hanoi/vietnam)
  // — title-only core identity must not treat them as the same event
  const a = cluster("Đà Nẵng: Rộn ràng đêm Trung thu sớm của trẻ em vùng cao", {
    summary: "Chương trình tại Hà Nội và Việt Nam quyên góp quà cho trẻ em.",
  });
  const b = cluster(
    "[Ảnh] Đêm hội 'Vầng trăng chiến sĩ': Nơi chắp cánh những ước mơ của trẻ em vùng khó",
    { summary: "Sự kiện tại Đà Nẵng, Hà Nội, Việt Nam thu hút đông đảo." },
  );
  assert.equal(await sameEvent(a, b), false);
});

test("hub entities alone: us+china names a beat, not an event", async () => {
  setupDb();
  const a = cluster(
    "Duy trì đối thoại-chìa khóa ổn định quan hệ Trung Quốc, Mỹ",
    {
      summary:
        "Chuyên gia bàn về quan hệ giữa ông Tập Cận Bình và Tổng thống Trump.",
    },
  );
  const b = cluster("Ông Tập lên đường thăm Mỹ", {
    summary: "Chủ tịch Trung Quốc Tập Cận Bình bắt đầu chuyến thăm Hoa Kỳ.",
  });
  assert.equal(await sameEvent(a, b), false);
});

test("summary person mentions must not anchor: Tô Lâm article vs Greenland deal", async () => {
  setupDb();
  const a = cluster(
    "Tổng Bí thư, Chủ tịch nước Tô Lâm đề xuất 3 trụ cột hợp tác",
    {
      summary:
        "Bên lề phiên thảo luận Đại hội đồng Liên hợp quốc tại Hoa Kỳ, ông Tô Lâm phát biểu.",
    },
  );
  const b = cluster("Mỹ, Đan Mạch, Greenland ký thỏa thuận về an ninh", {
    summary:
      "Tại Đại hội đồng Liên hợp quốc, Tổng thống Trump ký cùng Đan Mạch và Greenland; Tô Lâm cũng tham dự phiên.",
  });
  assert.equal(await sameEvent(a, b), false);
});

test("same war beat, different incidents: UAV strike videos stay split", async () => {
  setupDb();
  const a = cluster(
    "Nga bắn hạ gần 200 UAV ở Kursk, mời Tổng thống Ukraine đến Moscow hội đàm",
  );
  const b = cluster(
    "Video UAV Ukraine bắn cháy xe tăng T-72 và lựu pháo của Nga ở Donetsk",
  );
  assert.equal(await sameEvent(a, b), false);
});

test("same competition, different sub-events: ASIAD football vs shooting", async () => {
  setupDb();
  const a = cluster("Xác định 8 đội vào tứ kết bóng đá nam ASIAD 2026");
  const b = cluster(
    "Bắn súng Việt Nam mất suất chung kết ASIAD 2026 nhưng vẫn còn cơ hội",
  );
  assert.equal(await sameEvent(a, b), false);
});

test("schedule boilerplate bigram: ASEAN Cup schedule vs ASIAD schedule", async () => {
  setupDb();
  const a = cluster(
    "Lịch thi đấu FIFA ASEAN Cup 2026 mới nhất: Tuyển Việt Nam sẵn sàng đại chiến Thái Lan",
  );
  const b = cluster(
    "Lịch thi đấu tứ kết bóng đá nam Asiad 20: U23 Việt Nam đấu Hàn Quốc",
  );
  assert.equal(await sameEvent(a, b), false);
});

test("numeric mismatch vetoes entity match: 200 drones vs T-72", async () => {
  setupDb();
  const a = cluster("Nga bắn hạ gần 200 UAV ở Kursk");
  const b = cluster("Video UAV Ukraine bắn cháy xe tăng T-72 của Nga");
  assert.equal(await sameEvent(a, b), false);
});

/* ----------------------------- must merge --------------------------------- */

test("cross-language numeric bridge: 46% tariff vi/en merges", async () => {
  setupDb();
  const a = cluster("Mỹ áp thuế 46% hàng Việt Nam", { language: "vi" });
  const b = cluster("US imposes 46% tariff on Vietnamese goods", {
    language: "en",
  });
  assert.equal(await sameEvent(a, b), true);
});

test("same sub-event across wording: ASIAD quarter-final draw", async () => {
  setupDb();
  const a = cluster("Xác định 4 trận tứ kết bóng đá nam ASIAD 2026");
  const b = cluster("Xác định 4 cặp đấu ở vòng tứ kết bóng đá nam Asiad 20");
  assert.equal(await sameEvent(a, b), true);
});

test("wire copies of one story merge", async () => {
  setupDb();
  const a = cluster("Ông Tập lên đường thăm Mỹ", { source: "VnExpress" });
  const b = cluster("Ông Tập lên đường thăm Mỹ", { source: "Tuổi Trẻ" });
  assert.equal(await sameEvent(a, b), true);
});

/* ------------- named V2 regression cases (pure layer + DB) ------------------ */

import { buildIncomingSide, decide, type CandidateSide } from "../lib/resolver";

/** candidate view of a cluster — mirrors what the DB layer builds */
function candOf(c: StoryCluster, embedding?: number[]): CandidateSide {
  const inc = buildIncomingSide(c, extractClaims(c));
  return {
    id: c.id,
    signature: inc.signature,
    entitySignature: [...inc.entTokens].join(" "),
    entitySignatureCore: [...inc.entCoreTokens].join(" "),
    claimKeys: new Set(
      [...inc.distinctiveKeys, ...inc.genericFps].map((k) => k.split("|")[0]),
    ),
    claimFps: new Set(inc.genericFps),
    topic: c.topic,
    publishedAt: inc.publishedAt,
    language: inc.language,
    embedding,
  };
}

/** unit-ish 2-D vectors whose cosine equals `cos` */
function vecPair(cos: number): [number[], number[]] {
  return [
    [1, 0],
    [cos, Math.sqrt(Math.max(0, 1 - cos * cos))],
  ];
}

test("cross-language paraphrase merges on semantic+entity support", () => {
  setupDb();
  const a = cluster("Triều Tiên phóng tên lửa đạn đạo ra biển Nhật Bản", {
    summary: "Triều Tiên vừa phóng tên lửa đạn đạo về phía biển Nhật Bản.",
    language: "vi",
  });
  const b = cluster("North Korea fires ballistic missile toward Sea of Japan", {
    summary: "Pyongyang launched a ballistic missile toward the Sea of Japan.",
    language: "en",
  });
  const [va, vb] = vecPair(0.84); // measured corpus cosine for this pair
  const d = decide(buildIncomingSide(b, extractClaims(b)), candOf(a, va));
  // embedding must reach the incoming side too — inject directly
  const inc = buildIncomingSide(b, extractClaims(b));
  inc.embedding = vb;
  const d2 = decide(inc, candOf(a, va));
  assert.equal(d2.decision, "merge");
  assert.equal(d2.path, "semantic_xlang");
  assert.ok(!d2.hardBlocks.length);
});

test("same actor, different incidents: NK missile vs military parade", () => {
  const a = cluster(
    "North Korea launches ballistic missile into Sea of Japan",
    {
      language: "en",
      publishedAt: "2026-03-02T01:00:00Z",
    },
  );
  const b = cluster("North Korea holds massive military parade in Pyongyang", {
    language: "en",
    publishedAt: "2026-03-03T01:00:00Z",
  });
  const [va, vb] = vecPair(0.8);
  const inc = buildIncomingSide(b, extractClaims(b));
  inc.embedding = vb;
  const d = decide(inc, candOf(a, va));
  // shared country + topic-class vocabulary is a beat, not an incident:
  // medium cosine with no distinctive anchor may not merge
  assert.notEqual(d.decision, "merge");
});

test("numeric evolution merges: 20 → 35 flights cancelled", async () => {
  setupDb();
  const a = cluster("Typhoon Ragasa: 20 flights cancelled in Japan", {
    language: "en",
    summary: "Typhoon Ragasa grounded 20 flights in southern Japan.",
  });
  const b = cluster("Typhoon Ragasa grounds 35 flights in Japan", {
    language: "en",
    summary: "The storm forced cancellation of 35 flights across Japan.",
  });
  // same storm, updated figure → one event; the figure change is a
  // ClaimVersion dispute, not a second event
  assert.equal(await sameEvent(a, b), true);
});

test("recurring meetings stay separate: Fed June vs September", async () => {
  setupDb();
  const a = cluster("Fed holds rates steady at June meeting", {
    language: "en",
    publishedAt: "2026-06-18T18:00:00Z",
  });
  const b = cluster("Fed cuts rates at September meeting", {
    language: "en",
    publishedAt: "2026-09-17T18:00:00Z",
  });
  // same institution + same rate predicate, different meeting period —
  // 91 days apart exceeds any incident window
  assert.equal(await sameEvent(a, b), false);
});

test("route evolution does not split a strong storm identity", async () => {
  setupDb();
  const a = cluster("Bão Kalmaegi đổ bộ Quảng Trị gây mưa lớn", {
    summary: "Bão Kalmaegi đổ bộ vào đất liền Quảng Trị.",
  });
  const b = cluster("Bão Kalmaegi gây ngập nặng tại Hà Tĩnh", {
    summary: "Sau Quảng Trị, bão Kalmaegi tiếp tục gây mưa lớn ở Hà Tĩnh.",
  });
  // same named storm — location progression is the story, not a veto
  assert.equal(await sameEvent(a, b), true);
});

test("generic fatalities never merge across events", async () => {
  setupDb();
  const a = cluster("Japan earthquake: 20 dead in Hokkaido", {
    language: "en",
    summary: "A magnitude 6 quake killed 20 people in Hokkaido.",
  });
  const b = cluster("Indonesia flood: 20 dead in Jakarta", {
    language: "en",
    summary: "Flooding in Jakarta left 20 people dead.",
  });
  // identical generic figure, disjoint event arguments
  assert.equal(await sameEvent(a, b), false);
});

test("headline drift merges on semantic+argument support", () => {
  const a = cluster(
    "Ông Đào Thanh Trường được bầu giữ chức Phó Chủ tịch UBND tỉnh Bắc Ninh",
    {
      summary:
        "Ông Đào Thanh Trường, Phó giám đốc ĐH Quốc gia Hà Nội, được bầu làm Phó Chủ tịch UBND tỉnh Bắc Ninh.",
    },
  );
  const b = cluster(
    "Phó giám đốc ĐH Quốc gia Hà Nội làm Phó chủ tịch Bắc Ninh",
    {
      summary:
        "Tân Phó Chủ tịch UBND tỉnh Bắc Ninh là Phó giám đốc Đại học Quốc gia Hà Nội.",
    },
  );
  const [va, vb] = vecPair(0.93); // measured corpus cosine for this pair
  const inc = buildIncomingSide(b, extractClaims(b));
  inc.embedding = vb;
  const d = decide(inc, candOf(a, va));
  assert.equal(d.decision, "merge");
});

test("topic siblings: two Ukraine drone incidents inside 72h stay split", async () => {
  setupDb();
  const a = cluster("Nga bắn hạ gần 200 UAV Ukraine ở Kursk", {
    summary: "Phòng không Nga bắn hạ gần 200 UAV của Ukraine tại Kursk.",
  });
  const b = cluster("Video UAV Ukraine bắn cháy xe tăng T-72 của Nga", {
    summary: "Đoạn video cho thấy UAV Ukraine tập kích xe tăng T-72.",
  });
  assert.equal(await sameEvent(a, b), false);
});

test("edition number is not a numeric conflict: ASEAN 47 merges", async () => {
  setupDb();
  const a = cluster("Hội nghị thượng đỉnh ASEAN khai mạc tại Kuala Lumpur", {
    summary:
      "Hội nghị thượng đỉnh ASEAN lần thứ 47 khai mạc tại Kuala Lumpur, Malaysia.",
  });
  const b = cluster("Thượng đỉnh ASEAN 47 chính thức mở đầu ở Malaysia", {
    summary: "Các nhà lãnh đạo ASEAN hội tụ tại Kuala Lumpur.",
  });
  const [va, vb] = vecPair(0.97);
  const inc = buildIncomingSide(b, extractClaims(b));
  inc.embedding = vb;
  const d = decide(inc, candOf(a, va));
  // one-sided edition marker (47) is missing evidence, not contradiction
  assert.equal(d.decision, "merge");
});
