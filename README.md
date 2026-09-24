# ThunderFeed — Bản tin nhận định

Sản phẩm **tổng hợp + phân tích tin tức** cho độc giả Việt — không phải trang báo.
Kết hợp format edition của Kagi News với độ sâu phân tích của Ground News.

Mỗi sự kiện là một cụm đa nguồn kèm: **nhận định**, phổ truyền thông 2 trục
(trong nước ↔ quốc tế, nhà nước ↔ tư nhân), đối chiếu giật tít, điểm mù
truyền thông (blindspot), và thông tin chủ sở hữu tòa soạn.

## Chạy local

Node.js ≥ 20.9. Cần mạng để lấy RSS.

```sh
npm install
npm run dev        # http://localhost:3000
```

Tùy chọn — nhận định sinh bởi Gemini (grounded, fail-closed):

```sh
echo "GEMINI_API_KEY=..." > .env.local   # có sẵn trong ../diem-tin/.env
```

Không có key vẫn chạy đầy đủ với nhận định deterministic.

```sh
npm test           # unit tests (node:test)
npm run typecheck  # tsc --noEmit
npm run build      # production build
npm run quality    # all three
```

## Kiến trúc

```
RSS (~50 nguồn, 15 phút refresh qua unstable_cache)
  → fetch + parse + dedupe          lib/news.ts
  → cluster thành sự kiện           lib/cluster.ts  (entity alias + bigram + Jaccard)
  → merge ngữ nghĩa vi↔en           lib/embed.ts + mergeClustersBySimilarity
                                    (Gemini embeddings, top clusters only — quota-aware)
  → theo dõi động lượng             lib/tracking.ts (momentum qua các edition, .cache/)
  → phân tích → nhận định           lib/analysis.ts (deterministic: framing diff, timeline)
                                  + lib/gemini.ts   (LLM grounded, optional)
                                  + lib/claims.ts   (ma trận dữ kiện đồng thuận/bất đồng)
  → Edition payload                 lib/edition.ts  (hero + 4 pillars + blindspots + wire)
  → Dashboard                       app/page.tsx + components/
```

Nguồn dữ liệu mở tái sử dụng: `data/kite_feeds.json` và `data/media_data.json`
từ `kagisearch/kite-public` (MIT — xem `data/KITE_LICENSE.txt`), bổ sung
`data/vn_media.json` cho báo Việt Nam (owner/typology).

## Nguyên tắc

- Nhận định AI chỉ render trên dữ kiện đã trích — mọi con số phải truy về
  được fact set, không khuyến nghị, không bịa (fail-closed → deterministic).
- Điểm mù truyền thông: sự kiện chỉ một phía đưa được gắn nhãn, không giấu.
- Source health luôn hiển thị — nguồn lỗi không âm thầm biến mất.
