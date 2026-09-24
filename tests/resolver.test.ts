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
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/, "");
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
  opts: { summary?: string; language?: "vi" | "en"; source?: string } = {},
): StoryCluster {
  const a: Article = {
    id: randomUUID(),
    title,
    summary: opts.summary ?? "",
    url: `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: new Date().toISOString(),
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
