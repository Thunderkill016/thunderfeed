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
- **affectedTargets**: canonical keys — instrument listings
  (`equity:HOSE:VNM`), macro series (`macro:fred:FEDFUNDS`), hoặc factor
  names (`USDVND`, `gold:world`, `vn:rates`) — theo catalog trong corpus.
- **evidenceConfidence**: lấy nguyên từ R6 claim state — không tính lại.
- **transmissionConfidence**: mức chắc của suy luận tác động — RIÊNG với
  evidence truth. `low/medium/high`.

## `unknown` là label hợp lệ

Với news events, `event_type='other'` và predicate noisy
(`money_usd`, `meeting`, `area_ha`) không đủ nền để ép classification.
`intrinsicMateriality='unknown'` + `channels=[]` là câu trả lời trung
thực của v1 — tốt hơn suy đoán sai.

## Labeling protocol

1. Label `intrinsicMateriality`, `scope`, `channels`, `directness`,
   `horizon`, `affectedTargets` — field names chính xác như trên.
2. Không label theo persona. Personal relevance là layer khác (R7 sau).
3. Mỗi label cần `labels.note` 1 dòng: lý do ngắn.
4. `labeled_by`: `agent-draft-v1` cho draft, `pm` khi PM đã review.

## Benchmark metrics (bench.mts)

- `materiality accuracy` — exact match trên 5 mức + off-by-one.
- `systemic false-positive rate` — predicted `major|systemic` nhưng
  labeled ≤ `limited`. (Hướng sai nguy hiểm nhất: inflating noise.)
- `channel accuracy` — Jaccard overlap của channel sets.
- `affected-target precision` — predicted targets ∩ labeled targets /
  predicted targets.
- `unsupported-causality rate` — dự đoán assert hướng/cause không có
  evidence ref. Baseline deterministic phải = 0.

Dev corpus R1–R6 KHÔNG phải test duy nhất cho R7 — corpus này đo materiality,
riêng biệt.
