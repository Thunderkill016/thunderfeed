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

## Bảo mật dữ liệu

Browser **không** nói chuyện trực tiếp với Supabase Data API — không có
`@supabase/supabase-js`, không có `NEXT_PUBLIC_SUPABASE_*`, không có anon key
trong client. Mọi truy cập đi qua server:

```
Browser → Next.js API/server → `pg` (role postgres qua pooler) → DB
Browser  ✗→  raw PostgREST tables
```

`db/migrations/0018_data_api_lockdown.sql` khoá raw surface:

- `ENABLE ROW LEVEL SECURITY` trên mọi bảng `public`, **không policy** →
  deny-by-default cho `anon`/`authenticated`.
- `REVOKE ALL` table/sequence privileges khỏi `anon`, `authenticated`.
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` → bảng mới sinh ra không có
  auto-grant; event trigger `tf_enable_rls_on_create` tự bật RLS.
- `SET search_path` cố định trên `uuid_v7` (`pg_catalog, extensions`) và
  `reject_history_mutation` (`pg_catalog`).

**Invariant cho Instrument Master** (và mọi bảng tài chính sau này):
`financial_instruments`, `instrument_versions`, `trading_venues`,
`instrument_listings`, `listing_versions`, `*_identifiers` … phải sinh ra
**không có anonymous raw-table access**. App access chỉ qua server API/read
models. Nếu sau này cố ý cho client query trực tiếp, thêm RLS policies hẹp
lúc đó — không tạo sẵn policy permissive.

Audit production (fail non-zero nếu vi phạm):

```sh
npm run audit:db-security
```

## Market data providers

Hai provider EOD là **hai assertions độc lập** — mỗi provider có
`market_series` riêng (`provider+dataset+interval+session_type+price_basis`
là identity, ticker chỉ là transport). Không average, không merge, không
âm thầm chọn "giá đúng"; khác nhau → ghi divergence.

- **Alpha Vantage** — `alphavantage` / `time_series_daily`, JSON daily.
- **Tiingo** — `tiingo` / `eod_daily`, CSV daily (raw OHLCV; các trường
  `adj*`/`divCash`/`splitFactor` chỉ nằm trong raw observation, chưa
  promote — Corporate Actions phase sau).

Importers: `scripts/market/import-alphavantage-daily.mts`,
`scripts/market/import-tiingo-eod.mts`, `scripts/market/compare-dual.mts`.

**Licensing**: dữ liệu Tiingo free/developer tier chỉ phù hợp internal/
developer use — redistribution hay public-commercial use cần quyền
provider phù hợp. Alpha Vantage tương tự theo provider terms. Raw payload
provider không được expose public; schema không encode giả định licensing.
Credentials chỉ tồn tại trong env — Tiingo token đi qua header
`Authorization`, không bao giờ trong URL/logs/source_url.
