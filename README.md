# ThunderFeed — Radar tín hiệu & bản tin nhận định

Hệ thống **event intelligence cho nhà đầu tư Việt** — phát hiện _cái gì vừa
thay đổi_ trước khi nó lên báo, kèm bằng chứng truy về được. Không khuyến nghị
mua/bán: tín hiệu là sự kiện có provenance, quyết định là của người đọc.

Hai tầng sản phẩm:

1. **Radar đa kênh** (`/radar`) — cổ phiếu VN (3 sàn), chỉ số, vàng VN
   (SJC/DOJI/PNJ/BTMC) + vàng TG (XAUUSD), crypto majors, và 4 nguồn tỷ giá
   USD/VND (reference, fawaz history, Vietcombank, P2P chợ tự do).
2. **Bản tin nhận định** — sự kiện tin tức đa nguồn kèm phổ truyền thông,
   đối chiếu giật tít, điểm mù, chủ sở hữu tòa soạn.

## Tín hiệu (signals)

Mỗi series có ngưỡng materiality riêng (metadata — vàng 1.5%, crypto 8%,
FX 0.5%, cổ phiếu 5%). Vượt ngưỡng trên phiên _fresh_ → mint `data_deltas`:

| Kind                               | Bắt gì                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `market_move`                      | Giá phiên đổi ≥ ngưỡng series                             |
| `premium_shift`                    | Series %-valued dịch ≥ 0.75pt (SJC−TG, USDT−official gap) |
| `volume_spike`                     | Volume ≥ N× median trailing (crypto 3×)                   |
| `macro_release` / `macro_revision` | Số liệu vĩ mô mới/bị sửa (FRED, WB, IMF)                  |
| `ca_declared` / `ca_updated`       | Corporate actions                                         |

Mọi delta mint kèm `signal_outcomes` T+1/T+5/T+20 **phiên** trong cùng
transaction → hồ sơ tín hiệu chấm điểm được, không marketing suông.
Outcome settled thì bất biến (DB trigger), stale >60 ngày → `expired`.

Derived series có provenance `derived` — SJC premium & USDT-gap tính từ
legs, payload observation chứa formula + legs nguyên vẹn.

## Kiến trúc dữ liệu

```
providers (giavang, binance, vndirect, fawaz, er_api, vietcombank,
           alphavantage, tiingo, fred, worldbank, imf, derived)
  → reference_observations   raw payload, append-only
  → market_points + market_point_versions   normalized, versioned
  → data_deltas              material changes only (fresh sessions)
  → signal_outcomes          T+1/5/20 resolution, immutable once settled
```

Quy tắc: không backfill mint delta; một version ≤ một delta; decimal
chuẩn xác không qua float; listing identity sống qua đổi ticker; provider
khác nhau = series khác nhau, không ghi đè.

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
- **Tiingo** — `tiingo` / `eod_daily`, CSV daily. Một raw CSV của Tiingo
  nuôi ba derivations hợp lệ từ cùng observation: OHLCV thô → series
  `as_traded`; các cột `adj*` của provider → series riêng
  `price_basis='provider_adjusted'` (giá trị của provider — không tự tính
  adjustment); `divCash`/`splitFactor` ≠ mặc định → corporate-action
  assertions.

Importers: `scripts/market/import-alphavantage-daily.mts`,
`scripts/market/import-tiingo-eod.mts`, `scripts/market/compare-dual.mts`,
`scripts/market/import-alpha-ca.mts`, `scripts/market/import-tiingo-ca.mts`,
`scripts/market/compare-ca.mts`.

## Corporate actions

`corporate_actions` attach vào `financial_instruments.id` — không bao giờ
vào ticker hay market series; listing chỉ là `source_listing_id`
(transport/provenance). Canonical identity = (instrument, type, ex_date);
amount/ratio/dates là semantic fields — provider sửa được bằng append-only
versions, không phải identity.

```
raw provider payload → reference_observations
  → corporate_action_assertions (provider truth, immutable)
  → corporate_action_versions (canonical, append-only)
  → corporate_action_derivations (asserts / corroborates / conflicts)
```

- **Alpha Vantage**: `DIVIDENDS` + `SPLITS` endpoints.
- **Tiingo**: rich `corporate-actions/*` endpoints đang bị entitlement
  (HTTP 403 free tier) — fallback hợp lệ là `divCash`/`splitFactor` của
  EOD CSV (dataset `eod_daily`).
- Canonical authorship: dedicated CA endpoint outrank cột EOD-derived;
  cross-provider disagreement ghi `role='conflicts'` + `divergence` —
  không bao giờ average.
- Read: `/api/instruments/<instrument-key>/corporate-actions`,
  `getCorporateActionsFor{Instrument,Listing}` + `getCorporateAction`.

**Licensing**: dữ liệu Tiingo free/developer tier chỉ phù hợp internal/
developer use — redistribution hay public-commercial use cần quyền
provider phù hợp. Alpha Vantage tương tự theo provider terms. Raw payload
provider không được expose public; schema không encode giả định licensing.
Credentials chỉ tồn tại trong env — Tiingo token đi qua header
`Authorization`, không bao giờ trong URL/logs/source_url.
