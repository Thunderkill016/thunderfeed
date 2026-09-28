# Materiality Rubric — R7.0 Quality Lab

Mục tiêu: phân biệt **sự kiện đúng** với **sự kiện đáng kể về mặt kinh
tế/đầu tư**. Câu hỏi trung tâm:

> Nếu thông tin này đúng, nó có khả năng thay đổi một quyết định đầu tư
> hợp lý — qua kênh kinh tế/tài chính nào, phạm vi nào, trong bao lâu,
> với mức chắc chắn nào?

Tham chiếu khái niệm: IFRS (material = có thể ảnh hưởng quyết định của
primary users), SEC (không chỉ ngưỡng số — xét cả magnitude lẫn
circumstances), CFA (giá trị tài sản ~ expected cash flows / discount
rate / risk premia), Fed/BIS (policy truyền qua rates → credit →
financial conditions → activity/inflation).

Ba vạch KHÔNG được trộn:

```text
TRUE EVENT  ≠  MATERIAL EVENT  ≠  EXPECTED MARKET DIRECTION
```

- `confirmed` (R6) chỉ nói bằng chứng mạnh — không nói gì về materiality.
- `material` không suy ra được hướng giá — và ThunderFeed v1 KHÔNG assert
  market direction.
- `material` không tự động là alpha — sự kiện có thể đã priced-in.

## intrinsicMateriality — 5 mức

| Mức          | Định nghĩa                                                       | Ví dụ                                                                    |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `none`       | Không có kênh kinh tế/tài chính nhận diện được                   | thể thao, pháp lý cá nhân, giải trí                                      |
| `limited`    | Có kênh nhưng nhỏ/issuer-lẻ hoặc context thuần                   | dividend nhỏ của mid-cap, chỉ số ngành lẻ                                |
| `meaningful` | Đổi được quyết định cho holder của issuer/sector chịu ảnh hưởng  | cổ tức >3% yield, hợp đồng lớn của blue chip, chỉ số nhóm ngành          |
| `major`      | Đổi được quyết định ở mức VN-systemic hoặc sector trụ cột        | SBV rate decision, VN CPI print bất thường, chính sách mới của Chính phủ |
| `systemic`   | Đổi điều kiện tài chính toàn cầu hoặc nhiều asset class cùng lúc | Fed rate decision, US CPI sốc, suy thoái/khủng hoảng tín dụng            |

Quy tắc chống inflate:

- **Số báo đăng không phải materiality.** 100 outlet copy Reuters cùng
  một assertion = một origin. Đếm nguồn là evidence strength (R6), không
  phải economic significance.
- **Forecast ≠ signal.** Series annual của IMF/World Bank là
  baseline/forecast context. Một forecast mới hiếm khi `meaningful` trừ
  khi thay đổi lớn so với forecast kỳ trước (revision, không phải
  release cadence).
- **Observation change ≠ historical abnormality ≠ consensus surprise.**
  Macro delta chỉ chứng minh giá trị mới. Abnormality đòi so với lịch sử
  của chính series đó. Surprise đòi consensus data — ThunderFeed chưa có
  → KHÔNG BAO GIỜ gọi "beat/miss expectations".
- **Market move ≠ nguyên nhân.** Một phiên ±3% chứng minh market
  reaction, không chứng minh tại sao. Market move có channel rỗng.
- **Stray predicate ≠ instrument.** Trên fused events, một predicate lạc
  quẻ (`sanctions` trong bài entertainment) không tạo materiality.
  `major` đòi ≥2 _instrument families_ khác nhau (tariff+sanctions mới
  đủ; 5 cách viết của cùng một tariff claim thì không), hoặc một hit
  trên kênh `discounting` (rate/yield decision là hành động thật).
- **War aid ≠ credit conditions.** Trên conflict events
  (`deaths/missile/uav/ceasefire` predicates), các claim
  `aid_disbursement`/`fund_disbursement`/`debt_to_gdp` là kế toán viện
  trợ chiến tranh — family `soft`, không thể lift lên `major`; và event
  chỉ được cap ở `meaningful` trừ khi có kênh `discounting` thật.

## Channels

| Channel             | Nội dung                                                           |
| ------------------- | ------------------------------------------------------------------ |
| `fundamental`       | cash flow, growth/demand, margin/input cost, balance sheet         |
| `discounting`       | policy rate, sovereign yield, inflation expectations, risk premium |
| `funding_liquidity` | credit availability, spreads, refinancing, banking liquidity       |
| `external`          | FX, trade, capital flows, commodity                                |
| `policy_regulatory` | tax, tariff, regulation, sanctions, legal constraint               |

## Dimensions còn lại

- **scope**: `issuer` → `sector` → `vietnam` → `global_systemic`
- **directness**: `direct` → `first_order` → `second_order` →
  `speculative`
- **persistence**: `transient` → `cyclical` → `structural`
- **horizon**: `immediate` / `weeks` / `months` / `long_term`
- **affectedTargets**: typed keys, KHÔNG phải bare entity slug — entity
  xuất hiện trong story ≠ tài sản chịu exposure. Các loại:
  `instrument:<asset>:<venue>:<ticker>` (equity:HOSE:VNM),
  `macro_factor:<provider>:<series>` (macro_factor:fred:FEDFUNDS),
  `country_exposure:<slug>` (country_exposure:vietnam),
  `entity:<slug>` (mention-only hint, chưa phải exposure),
  `sector:<slug>`. Trong label/bench, target so sánh theo dạng
  `type:key` stringified.
- **evidenceConfidence**: lấy nguyên từ R6 claim state — không tính lại.
- **transmissionConfidence**: mức chắc của suy luận tác động — RIÊNG với
  evidence truth. `low/medium/high`.

## Financial semantics (R7.0b hardening)

- **Series-measure registry**: mỗi macro series có `measure`
  (`level_index`, `rate_pct`, `price`, `stock`, `flow`,
  `sentiment_index`) và `role` (`decision` vs `effective` vs `market` vs
  `release`). Abnormality đo trên observation ĐÃ transform:
  `rate_pct/sentiment_index` → Δ (pp/points); `level_index/price/stock/
flow` → pct change. Z-score raw level của trending series (CPI index,
  PAYEMS, M2, S&P) là bị cấm — nó sản xuất abnormality giả.
- **Effective rate ≠ policy decision**: `FEDFUNDS` là effective market
  rate trong corridor — một step của nó là observation bất thường, không
  phải "Fed decision". Chỉ series `role=decision` (ví dụ `ECBDFR`) được
  mint reason "policy rate step".
- **Dividend yield cần price time-consistent**: `priceBasis='pre_ex'`
  (last close trước ex-date). `priceBasis='latest'` → caution
  `lookahead_price`, yield không dùng được → `limited`. `cash_amount ≥
referencePrice` → caution `provider_magnitude_unverified` (artifact
  kiểu GOOGL 2014 "$567.97 dividend") → `limited`.
- **Market-vol baseline out-of-sample**: `trailingVol` = stdev của các
  phiên TRƯỚC signal session — không gồm chính return đang test (in-
  sample sẽ tự phình baseline, tự giảm z).
- **Canonical provider policy**: dedupe theo instrument chọn provider
  theo priority cố định (`vndirect > tiingo > alphavantage` cho equity,
  `vietcombank > er_api > fawaz > binance > derived` cho FX, `giavang >
derived` cho commodity, `binance` cho crypto) — KHÔNG chọn provider có
  |z| lớn nhất (đó là cherry-picking anomaly).

## `unknown` là label hợp lệ

Với news events, `event_type='other'` và predicate noisy
(`money_usd`, `meeting`, `area_ha`) không đủ nền để ép classification.
`intrinsicMateriality='unknown'` + `channels=[]` là câu trả lời trung
thực của v1 — tốt hơn suy đoán sai.

## Labeling protocol

1. Label `intrinsicMateriality`, `scope`, `channels`, `directness`,
   `horizon`, `affectedTargets` — field names chính xác như trên;
   `affectedTargets` dùng typed `type:key` strings.
2. Không label theo persona. Personal relevance là layer khác (R7 sau).
3. Mỗi label cần `labels.note` 1 dòng: lý do ngắn.
4. `labeled_by`: `agent-draft-v1` cho draft pass đầu. `reviewed` +
   `reviewed_by` BẮT BUỘC cho mọi label `meaningful|major|systemic`
   trước khi label đó được dùng làm acceptance gate.

## Benchmark metrics (bench.mts)

- `coverage` / `abstention` — tỉ lệ engine trả `unknown`. Báo cáo rõ
  ràng, không giấu vào accuracy.
- `accuracy` — `overall` (mọi labeled item), `within-1` rank, và
  `classified-only` (chỉ items không abstain).
- `confusion matrix` — label × prediction.
- `'material' flag P/R/F1` — boundary `meaningful+`.
- `high-impact FP rate` — predicted `major|systemic` nhưng labeled <
  `major`. Đo riêng trên holdout và challenge.
- `channel IoU` — Jaccard, **per-kind lẫn overall** (aggregate che được
  gap: events ~0.12 vs macro ~0.9).
- `target P/R/F1` — typed targets; recall bắt buộc (engine không được
  game bằng cách dự đoán ít).
- `unsupported-causality rate` — channels asserted nơi label nói không
  có; market_move phải luôn channels=[].
- `label provenance` — số labels đã second-review; số labels
  `meaningful+` chưa review (phải = 0 trước khi gate).

## Challenge set

`tests/fixtures/materiality-challenge.json` — curated historical/
synthetic cases (Fed/ECB steps, 46% VN tariff, SVB/BTFP, COVID lockdown,
GOOGL-2014 provider artifact, look-ahead dividend, routine negatives).
Mọi item có `sourceSet="challenge"` — bench báo riêng, KHÔNG BAO GIỜ
trộn vào holdout. Tập này tồn tại vì holdout 48h không chứa đủ
`major|systemic` để làm safety gate.

Dev corpus R1–R6 KHÔNG phải test duy nhất cho R7 — corpus này đo materiality,
riêng biệt.
