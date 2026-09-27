# ThunderFeed — Kế hoạch phát triển năng lực nghiên cứu tài chính

Ngày nghiên cứu: 27/09/2026. Trạng thái: đề xuất sản phẩm và kỹ thuật, chưa phê duyệt ngân sách, chưa triển khai.

## 0. Kế hoạch đang áp dụng: solo, miễn phí, tích hợp trước

**Cập nhật theo yêu cầu người dùng 27/09/2026:** một người tự phát triển; ưu tiên không phát sinh phí API/phần mềm; tận dụng repo có sẵn. Phần này thay thế giả định đội ngũ và lộ trình 90 ngày ở mục 7/9. Các nguyên tắc truy nguồn, dữ liệu đúng kỳ và đánh giá vẫn giữ. Không cần tuyển analyst, mua terminal hay dựng hạ tầng quỹ.

### Kết quả thực tế cần đạt

Một trang mỗi ngày cho biết: tin kinh tế nào quan trọng, số liệu nào vừa đổi, liên quan Việt Nam thế nào, nguồn gốc ở đâu. Độ chính xác cao nhắm vào **dữ kiện có thể kiểm chứng**; diễn giải là giả thuyết có điều kiện. Không hứa độ chính xác cao cho dự báo giá chỉ vì dùng nhiều nguồn hoặc AI.

MVP đề xuất: 10–15 nguồn tin chọn lọc từ feed hiện có, 10 series macro đang tích hợp, 5 chỉ tiêu Việt Nam, watchlist cá nhân tối đa 10 tài sản và bản tin ngắn. Đây là giới hạn workload để một người kiểm tra được, không phải giới hạn kỹ thuật. Dùng daily/EOD và lịch công bố, không cần giá từng giây. Dữ liệu Việt Nam khó tự động có thể nhập CSV có URL, kỳ, đơn vị và ngày công bố trước; nhập tay đúng vẫn tốt hơn tự động sai.

### Bộ công cụ nên chọn

| Công cụ/nguồn                                          | Quyết định                            | Cách tích hợp tối thiểu và giới hạn                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSS, FRED, SEC EDGAR và Công báo đã có                 | **Giữ, làm trước**                    | Không thay adapter đang chạy chỉ để dùng framework. FRED cần API key; SEC có JSON API. Metadata/citations và lịch công bố quan trọng hơn thêm nguồn.                                                                                                                                           |
| [Vnstock](https://github.com/thinh-vu/vnstock)         | **Ứng viên ưu tiên thử cho Việt Nam** | Python batch xuất JSON, đi vào validation/provenance hiện có. README hiện mô tả source-available, giấy phép riêng và miễn phí cá nhân/nghiên cứu; không mặc định MIT dựa vào fork hoặc phiên bản cũ. Quyền phần mềm không bao gồm quyền dữ liệu bên thứ ba. Chưa thử runtime trên ThunderFeed. |
| [Trafilatura](https://github.com/adbar/trafilatura)    | **Chỉ thêm nếu RSS thiếu bằng chứng** | Trích nội dung HTML thành text/metadata cho nguồn được phép truy cập; Apache-2.0 ở bản hiện tại. Không dùng để vượt paywall; không coi extractor là kiểm chứng sự thật.                                                                                                                        |
| [EdgarTools](https://github.com/dgunning/edgartools)   | **Để sau, khi cần đọc 10-K/XBRL sâu** | MIT; thư viện Python đọc filing và financials. Adapter SEC hiện có đủ cho tin công bố thì giữ nguyên; chỉ thay phần parser thiếu, không làm hai pipeline SEC.                                                                                                                                  |
| [yfinance](https://github.com/ranaroussi/yfinance)     | **Tùy chọn nghiên cứu cá nhân, EOD**  | Apache-2.0 cho code; README nêu Yahoo data dành cho personal use. Chỉ dùng nếu provider hiện có không đáp ứng; kiểm tra splits, adjusted/raw, timezone và missing bars. Không nguồn giao dịch chính thức, không suy ra quyền public display.                                                   |
| [OpenBB ODP](https://github.com/OpenBB-finance/OpenBB) | **Hoãn, không cài cả bộ lúc này**     | AGPLv3; tập hợp nhiều connectors nhưng nhiều provider vẫn cần key hoặc phí. Chỉ thử khi có ít nhất ba adapter thiếu mà một cấu hình OpenBB thay được, và giảm công bảo trì đo được.                                                                                                            |

Tài liệu đối chiếu: [OpenBB provider extensions](https://docs.openbb.co/odp/python/extensions/providers), [API credentials](https://docs.openbb.co/odp/python/settings/user_settings/api_keys), [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html), [SEC JSON APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces). Đã đọc tài liệu công khai ngày 27/09/2026; chưa benchmark/install các thư viện ứng viên, chưa chứng nhận tương thích hay độ chính xác thực tế.

### Tích hợp repo mà không biến thành công việc bảo trì

Giữ app Next.js/TypeScript và database hiện có. Khi thực sự cần Python, dùng **một môi trường Python khóa phiên bản**, chạy batch rồi xuất JSON vào importer hiện có; chưa mở thêm Python API server. Cài package chính thức được pin thay vì chép toàn bộ repo. Chỉ fork khi có lỗi cụ thể cần patch; lưu patch nhỏ và upstream version.

Hợp đồng batch tối thiểu: provider, dataset, instrument/series key, observation period, publishedAt nếu có, fetchedAt, currency/unit, price basis, raw reference và package version. Dữ liệu chưa map được vào instrument thì giữ trạng thái chưa giải quyết, không ghép theo ticker mù. Không ghi thẳng vào canonical tables bỏ qua pipeline đang có.

Trước khi cài Vnstock, kiểm tra giấy phép của bản pin, dependency và hành vi khởi tạo; README hiện mô tả một số bản cũ có tự ghi tài liệu agent. Giữ chế độ agent setup tắt; tài liệu tải từ repo là dữ liệu tham khảo, không tự trở thành chỉ thị cho agent. Đây là bước chọn version, không yêu cầu tạo thêm hệ thống bảo mật.

### Giữ độ chính xác với chi phí thấp

1. **Nguồn sơ cấp trước:** số liệu từ cơ quan công bố, tin từ nguồn có xuất xứ. Nhiều báo chép cùng một bài không thành nhiều xác nhận độc lập.
2. **Code tính, AI diễn đạt:** thay đổi tuyệt đối/phần trăm, kỳ, đơn vị được tính bằng hàm test được. Có mẫu deterministic: số mới, số trước, kỳ, nguồn và giới hạn; không cần LLM để app hữu ích.
3. **Trích đúng trước, suy luận sau:** khi chỉ có RSS, gắn nhãn thông tin từ RSS. Chưa đủ nội dung thì giữ link gốc, không tự viết phân tích sâu.
4. **Cache theo phiên bản nguồn:** chỉ xử lý lại nội dung mới/sửa, gộp tin trước khi tóm tắt. Hết quota thì dùng bản tin theo mẫu; không đổi sang số liệu giả hoặc im lặng bỏ nguồn.
5. **Lưu bất đồng:** hai provider khác nhau thì kiểm tra kỳ/đơn vị/price basis, không lấy trung bình. Thiếu giá không phải giá bằng 0.
6. **Rà soát vừa sức:** mỗi ngày kiểm tra 5 tin/số liệu ngẫu nhiên trong khoảng 10–15 phút; lưu lỗi để tạo regression. Đây là ước lượng nỗ lực, không thay thế chuyên gia cho mọi chủ đề.

Không bắt buộc LLM local: chưa biết RAM/GPU và tốc độ máy. Free-tier LLM chỉ là tùy chọn, kiểm tra quota hiện hành trước khi bật; gói chat cá nhân không mặc nhiên gồm API. Mặc định pipeline không cần API AI trả phí.

### Miễn phí ở mức nào?

**Mục tiêu: 0 đồng phí phần mềm và API bắt buộc** khi chạy cá nhân trên máy sẵn có. Vẫn có điện, internet, dung lượng và thời gian; không hứa hosting 24/7 miễn phí. Không di chuyển DB đang dùng chỉ để tối ưu phí khi chưa biết quota/hoá đơn thực.

Lịch chạy bằng cron/systemd timer trên máy đang bật; máy ngủ/tắt thì không thu thập, UI phải hiện lần cập nhật cuối. News gợi ý 30–60 phút khi máy bật, macro theo lịch nguồn, EOD sau phiên với timezone đúng; điều chỉnh trong giới hạn nguồn. Chạy thủ công và CSV import là fallback có thể dùng ngay. Public hosting và phân phối dữ liệu là quyết định riêng sau khi biết quyền sử dụng; mặc định không phát sinh subscription mới.

### Lộ trình solo: bốn đợt nhỏ

Ước lượng 4–6 tuần nếu làm bán thời gian đều đặn; ưu tiên nghiệm thu từng đợt hơn ngày hứa hẹn.

| Đợt                        | Việc làm                                                                                                                                                                                | Xong khi                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Bản miễn phí dùng được | Thu hẹp danh sách nguồn; chạy lại các adapter có sẵn; đảm bảo bản tin theo mẫu khi tắt AI; hiện freshness và lỗi                                                                        | Tắt API AI vẫn đọc được bản tin có nguồn; missing không biến thành 0; có baseline 30 trường hợp                                                                                |
| 2 — Việt Nam               | Spike Vnstock trên 3 mã × 20 phiên, gồm một ca corporate action nếu có; so ít nhất 10 điểm có thể đối chiếu với công bố gốc. Pilot 5 chỉ tiêu macro bằng CSV có nguồn trước khi tự động | Không lỗi identity/unit/date trong mẫu; adjusted/raw được tách; khác biệt có giải thích, dữ liệu không kiểm chứng gắn nhãn. Thử thất bại thì giữ CSV, không kéo dài vô hạn     |
| 3 — Tin rõ bằng chứng      | Chỉ thử Trafilatura trên 20 URL nếu thiếu full text thực sự cản trở; so với RSS và đọc tay; thêm kiểm tra câu sai chủ thể/sai kỳ/nhân quả                                               | 30 cases đánh giá gồm cả câu hợp lệ và phản ví dụ, 10 cases holdout; không nhận lỗi nghiêm trọng và vẫn trả lời đúng ≥90% câu hợp lệ. Đây là mục tiêu, không là kết quả đã đạt |
| 4 — Dùng hằng ngày         | Watchlist 10 mã, digest, tin đã đọc và sửa tin; chạy thử 7 ngày; ghi lỗi/công bảo trì                                                                                                   | Không phát sinh API trả phí; lỗi nguồn nhìn thấy; mục tiêu bảo trì thường lệ ≤30 phút/ngày và bản tin giúp hoàn thành 5 câu hỏi thực                                           |

**Thứ tự chốt:** tận dụng adapter hiện có → thử Vnstock có giới hạn → thêm extractor nếu thiếu nội dung → EdgarTools khi cần filings sâu. OpenBB, portfolio optimizer, backtest, multi-agent và microservices chưa nằm trong MVP.

Bước code đầu tiên vẫn là quality gate nhỏ cho dữ kiện/câu trả lời, kết hợp kiểm chứng chế độ không AI; không mở một nền tảng mới. Không chạy full suite trong lượt nghiên cứu này vì chỉ thay tài liệu, không thay mã thực thi.

## 1. Quyết định định hướng

Phát triển ThunderFeed thành **bàn nghiên cứu kinh tế và thị trường dành cho người Việt**, nối sự kiện thế giới với dữ liệu, doanh nghiệp, tài sản và cuộc sống Việt Nam. Điểm khác biệt cần sở hữu: biết điều gì vừa thay đổi, bằng chứng nào hỗ trợ, ai có thể bị ảnh hưởng, và điều gì còn chưa biết.

Học quy trình nghiên cứu và kiểm soát của định chế lớn; không tuyên bố sao chép hệ thống nội bộ, hiệu quả đầu tư hoặc quy mô của họ. Các tổ chức bên dưới là mẫu tham chiếu theo năng lực, không phải bảng xếp hạng AUM. Tài liệu công khai mô tả sản phẩm/phương pháp, không chứng minh hiệu suất của ThunderFeed.

Vẫn phục vụ tất cả đối tượng, dùng chung một lớp dữ kiện với ba cách trình bày:

- **Cuộc sống:** giá cả, việc làm, thu nhập, chi phí vay, chính sách và dịch vụ thiết yếu.
- **Kinh doanh:** nhu cầu, tỷ giá, đầu vào, chuỗi cung ứng, vốn và quy định.
- **Đầu tư/nghiên cứu:** dữ liệu vĩ mô, công bố doanh nghiệp, định giá, luận điểm, kịch bản và mức phơi nhiễm.

Độ sâu được mở dần: bản tin ngắn → hồ sơ sự kiện → dữ liệu gốc → bàn nghiên cứu. Không bắt người đọc phổ thông dùng giao diện giao dịch chuyên nghiệp.

## 2. Hiện trạng đã kiểm tra

Checkout `main`, HEAD `9f6e56b`; đang có WIP ở giao diện, read model và importer FRED. Kế hoạch này không sửa các phần đó. Chỉ kiểm tra repository và tài liệu công khai; chưa truy vấn DB, kiểm tra production, chạy lại bộ test hay đánh giá người dùng. File audit trong `bench/` là bằng chứng lịch sử của lần chạy được ghi trong file.

| Năng lực                                    | Bằng chứng tại repo                                                    | Đánh giá                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Bản tin, cụm sự kiện, nguồn và nhận định    | `lib/edition.ts`, `lib/cluster.ts`, `lib/claims.ts`, `lib/lineage.ts`  | Có nền tảng; cần benchmark trên tình huống tài chính thực               |
| Định danh doanh nghiệp/tài sản và niêm yết  | `lib/instruments.ts`, migrations 0020–0022                             | Tái sử dụng; không tạo security master thứ hai                          |
| Giá EOD, raw/adjusted và khác biệt provider | `lib/market.ts`, `lib/db/market.ts`, README                            | Có hợp đồng dữ liệu; chưa xác minh entitlement và vận hành hiện tại     |
| Corporate actions có lịch sử                | `lib/corporate-actions.ts`, migration 0026                             | Tái sử dụng cho nghiên cứu tài sản                                      |
| Macro và revision                           | `lib/macro.ts`, `lib/db/macro.ts`, migration 0027                      | Có versioning; importer ghi rõ chưa liệt kê đầy đủ ALFRED vintages      |
| Luồng thay đổi thống nhất                   | `lib/changes.ts`, migration 0028, `components/ChangesRail.tsx`         | Điểm xuất phát tốt cho cảnh báo nghiên cứu                              |
| Hỏi đáp theo bằng chứng                     | `lib/ask.ts:104–110`                                                   | Kiểm tra số không đủ để xác nhận chủ thể, phủ định hay quan hệ nhân quả |
| Danh mục, thesis, scenario, backtest        | Chưa thấy subsystem chuyên trách qua khảo sát `lib/`, `app/`, `tests/` | Chỉ đưa vào sau các cổng dữ liệu và nghiên cứu                          |

Hai rủi ro kỹ thuật cần đánh giá đầu tiên:

1. Câu chứa đúng số vẫn có thể gán sai doanh nghiệp, sai kỳ, đảo chiều tăng/giảm hoặc bịa nguyên nhân. `isGroundedAnswer` hiện không chứng minh toàn bộ ngữ nghĩa.
2. Lưu revision từ hôm nay không đồng nghĩa có dữ liệu đã biết ở mọi ngày trong quá khứ. `scripts/macro/import-fred.mts:16–18` nêu latest-vintage history và chưa có full vintage enumeration. Không được dùng dữ liệu sửa sau để chứng minh chiến lược quá khứ.

## 3. Học gì từ định chế lớn

| Tham chiếu                        | Năng lực công khai                                                        | Chuyển thành thiết kế ThunderFeed                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| BlackRock Aladdin                 | Tổng hợp phơi nhiễm và rủi ro nhiều nhóm tài sản; stress/scenario         | Sau khi có holdings: nhìn rủi ro theo yếu tố chung, công khai dữ liệu thiếu và giả định. Chưa cần làm toàn bộ OMS/PMS. [S1] |
| J.P. Morgan Markets               | Nghiên cứu kinh tế, thị trường và ngành trong workflow tổ chức            | Research brief có dữ liệu, luận điểm, phản biện, tác nhân cần theo dõi; mọi forecast ghi tác giả, thời điểm, kỳ hạn. [S2]   |
| Bridgewater                       | Hiểu kinh tế theo cơ chế, hệ thống hóa giả thuyết và kiểm tra với thực tế | Sổ luận điểm và sơ đồ truyền dẫn có điều kiện; phân biệt giả thuyết với kết luận nhân quả. [S3]                             |
| Two Sigma                         | Tiếp cận thị trường bằng phương pháp khoa học                             | Mỗi ý tưởng có giả thuyết, dữ liệu được biết lúc đó, baseline, holdout và kết quả có thể tái lập. [S4]                      |
| Norges Bank Investment Management | Khung nhận diện, đo lường, quản lý và báo cáo rủi ro                      | Nhật ký quyết định, benchmark rõ ràng, người kiểm tra độc lập, theo dõi sai số và ngoại lệ. [S5]                            |
| Bloomberg (nhà cung cấp hạ tầng)  | Kết nối dữ liệu và công cụ phân tích                                      | Trải nghiệm nối event ↔ entity ↔ instrument ↔ macro; mua/tích hợp dữ liệu phù hợp thay vì xây toàn bộ nguồn cấp. [S6]       |

Các thiết kế ở cột cuối là đề xuất suy ra từ nghiên cứu, không phải mô tả hệ thống nội bộ của các tổ chức.

## 4. Sản phẩm mục tiêu

### A. Bàn tin hàng ngày

Mở trang thấy: những thay đổi quan trọng kể từ lần đọc trước, kỳ công bố tiếp theo, nguồn chậm/lỗi, và phần liên quan Việt Nam. Mỗi tin trả lời: chuyện gì đổi; so với mốc nào; dữ kiện hay nhận định; bằng chứng đâu; nên theo dõi điều gì tiếp.

Cảnh báo dựa trên thay đổi vật chất, không dựa đơn thuần số bài đăng. Cập nhật/sửa/rút lại phải nối với thông báo trước đó. Có digest, mức ưu tiên và lựa chọn phạm vi; đo cảnh báo hữu ích thay vì tối đa lượt gửi.

### B. Hồ sơ nghiên cứu

Từ sự kiện mở được chuỗi bằng chứng, số liệu đúng kỳ/đơn vị, các ý kiến trái chiều, lịch sử cập nhật và tài sản/ngành liên quan. Liên kết ngành/tài sản không tự trở thành bằng chứng tác động giá.

Mẫu brief: câu hỏi → dữ kiện → điều thay đổi → cơ chế giả định → bằng chứng ủng hộ/phản bác → kịch bản → điều kiện bác bỏ → lần kiểm tra tiếp theo. Mỗi phiên bản giữ tác giả/người duyệt, thời điểm và bộ bằng chứng đã dùng.

### C. Bàn vĩ mô Việt Nam và thế giới

Nhóm tăng trưởng, lạm phát, việc làm, tín dụng, thanh khoản, lãi suất, tỷ giá, thương mại và năng lượng. Tách actual, previous-as-released, revised-previous, survey consensus và model forecast. Thiếu consensus thì không tính surprise. Không đồng nhất chỉ số CPI với tỷ lệ tăng CPI, lãi suất điều hành với lãi vay, hay USD index với USD/VND.

### D. Sổ luận điểm và kịch bản

Ví dụ giả định, không phải nhận định thị trường hiện tại: “Nếu dầu tăng và duy trì đủ lâu, chi phí vận tải Việt Nam có thể chịu áp lực.” Ghi riêng điều kiện, cơ chế, độ trễ chưa biết, bằng chứng giá nhiên liệu nội địa, khả năng doanh nghiệp chuyển giá và yếu tố phản bác. Khi đầu vào thay đổi, yêu cầu xem xét lại thesis; không âm thầm sửa lịch sử.

### E. Danh mục thử nghiệm, sau các cổng nền tảng

Người dùng nhập holdings hoặc dùng danh mục mô phỏng được gắn nhãn. Hiển thị tập trung theo tài sản/ngành/tiền tệ; tài sản không có dữ liệu vẫn nằm trong mẫu số và xuất hiện ở phần coverage thiếu. Stress test là kết quả có điều kiện theo mô hình, không phải dự báo. Chưa cung cấp giao dịch tự động, tối ưu hóa hay VaR nếu mô hình chưa được kiểm định.

## 5. Kiến trúc và hợp đồng cần bổ sung

Giữ Next.js/TypeScript, Postgres, adapters và canonical models hiện có. Giai đoạn này không cần microservices, graph database hoặc vector database riêng.

Luồng mục tiêu:

`Provider → raw observation → validated/versioned data → event/claim/delta → research brief/thesis → watchlist hoặc exposure → đánh giá kết quả`

- **Thời gian:** tách kỳ quan sát, thời điểm công bố, provider vintage và thời điểm ThunderFeed thu nhận. Truy vấn “biết lúc T” phải nêu là công chúng đã biết hay hệ thống đã thu nhận; dữ liệu chỉ có ngày không giả định giờ công bố.
- **Claim:** chủ thể, predicate, giá trị/đơn vị/kỳ, trích đoạn hỗ trợ, observation/version ID, trạng thái xung đột và phạm vi áp dụng. Phân biệt dữ kiện, diễn giải, dự báo, kịch bản.
- **Research/thesis:** phiên bản bất biến, câu hỏi, evidence IDs, giả định, phản chứng, điều kiện bác bỏ, hạn đánh giá, reviewer và kết quả.
- **Quyền dữ liệu:** registry theo provider/dataset/use case cho internal, display, redistribution, retention; chưa xác nhận quyền thì không coi là đã có quyền công khai.
- **Vận hành:** lịch ingest tách khỏi lượt truy cập, retry có phân loại, idempotency, replay, freshness theo lịch nguồn, cảnh báo lỗi và phục hồi kiểm thử. Chọn scheduler/queue theo môi trường triển khai thực tế trước khi thêm hạ tầng.
- **AI:** hỗ trợ trích xuất/tóm tắt và gợi ý câu hỏi; con số tính bằng code. Câu quan trọng phải có liên kết hỗ trợ đúng ngữ nghĩa hoặc trả lời thiếu bằng chứng. Không dùng confidence của model làm độ tin cậy nguồn.

## 6. Dữ liệu: mở rộng có thứ tự

| Nhóm                                | Nguồn / tái sử dụng                                  | Cổng trước khi đưa ra người dùng                                                                           |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Macro Mỹ                            | FRED/ALFRED hiện có; metadata cơ quan phát hành      | Vintage replay, đơn vị/tần suất, lịch công bố, quyền từng series [S7]                                      |
| Doanh nghiệp Mỹ                     | Adapter SEC EDGAR hiện có; bổ sung XBRL theo nhu cầu | Filing/amendment, fiscal period, đơn vị và taxonomy; không trộn quý với YTD [S8]                           |
| Macro Việt Nam                      | Thí điểm báo cáo chính thức của Cục Thống kê         | Lưu bảng/trang gốc, kỳ và revision; người rà soát mẫu trích PDF/HTML [S9]                                  |
| Tỷ giá/lãi suất/chính sách Việt Nam | Lập registry nguồn chính thức NHNN và văn bản        | Xác minh endpoint, lịch, định nghĩa và điều kiện sử dụng; chưa coi connector đã có                         |
| Giá/chỉ số/doanh nghiệp Việt Nam    | Đánh giá nhà cung cấp và nguồn công bố sở giao dịch  | Hợp đồng quyền hiển thị, corporate actions, mã định danh và độ trễ; chưa chọn provider khi chưa có báo giá |
| Giá toàn cầu                        | Alpha Vantage/Tiingo đang có                         | Đối chiếu provenance, basis, calendars và entitlement hiện tại                                             |
| Consensus                           | Nhà cung cấp khảo sát được cấp quyền                 | Lưu snapshot trước công bố, số người khảo sát/phạm vi nếu có; để trống khi chưa mua                        |
| Tin và báo cáo                      | RSS/nguồn sơ cấp hiện có                             | Giữ liên kết nguồn; tách quyền mã nguồn MIT khỏi quyền nội dung và dữ liệu                                 |

Không lấy thêm hàng trăm nguồn trước khi đo nguồn hiện có bị thiếu, trùng, chậm hoặc sai ở đâu.

## 7. Tham khảo dài hạn — lộ trình 90 ngày cũ, không phải kế hoạch đang áp dụng

Các mốc là ước lượng lập kế hoạch, giả định 2 kỹ sư toàn thời gian + 1 analyst/editor, reviewer rủi ro bán thời gian và quyền dữ liệu được giải quyết đúng hạn. Một người làm cần thu hẹp phạm vi hoặc kéo dài; không cam kết ngày trước khi chốt năng lực.

| Giai đoạn                                | Đầu ra                                                                                                          | Điều kiện qua cổng                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tuần 1–2: đo và khóa chất lượng          | Inventory, benchmark 100 tình huống, baseline latency/cost, registry quyền dữ liệu, kiểm tra semantic grounding | Không còn lỗi nghiêm trọng ở identity/unit/time trên corpus; kết quả và giới hạn công khai nội bộ                                                      |
| Tuần 3–4: dữ liệu theo thời điểm         | ALFRED cho tập series nhỏ, replay as-of, lịch công bố, pilot 5 series Việt Nam                                  | Replay không nhìn trước trên corpus đóng băng; mọi điểm có raw/version/đơn vị/kỳ; thiếu vintage được báo rõ                                            |
| Tuần 5–7: Research Desk                  | Brief có phiên bản, citations, phản biện và review; nối event/macro/instrument                                  | 30 brief được analyst chấm; 100% phát biểu quan trọng truy nguồn; không có lỗi nghiêm trọng; khả năng trả lời đủ dữ kiện không suy giảm vì chỉ abstain |
| Tuần 8–10: thesis và cảnh báo            | Watchlist, điều kiện bác bỏ, digest, correction propagation                                                     | Replay phát hiện ≥90% thay đổi quan trọng đã gán nhãn; precision ≥85%; không cảnh báo trùng cùng version                                               |
| Tuần 11–13: pilot và quyết định danh mục | Thử với 12 người, 4 mỗi nhóm; prototype exposure nếu đủ dữ liệu                                                 | Hoàn thành đúng ≥80% tác vụ; thời gian trung vị giảm ≥25% so baseline; không tăng nhận định thiếu bằng chứng                                           |

Các ngưỡng là **mục tiêu đề xuất**, chưa phải kết quả đạt được. Nếu không qua cổng thì sửa lỗi và đo lại, không thêm tính năng để che khoảng trống. Danh mục có thể lùi khỏi 90 ngày nếu data/brief chưa đạt.

## 8. Đánh giá và vận hành nghiên cứu

Corpus 100 tình huống đề xuất: 20 revision/as-of; 20 identity/đơn vị/kỳ; 20 claim hỗ trợ/phản bác; 20 truyền dẫn thế giới–Việt Nam; 20 nguồn lỗi/thiếu/trùng và sửa tin. Tách tập phát triển và holdout, giữ cả tình huống đủ dữ liệu để ngăn tối ưu bằng từ chối mọi câu hỏi. Cases synthetic dùng kiểm thử invariant; cases công khai được chuyên gia gán nhãn dùng đo chất lượng thực.

So sánh ba mức trên cùng dữ liệu: feed hiện tại, đọc nguồn thủ công, ThunderFeed Research Desk. Đo độ đúng, unsupported claim rate, coverage câu trả lời, thời gian hoàn thành, cảnh báo sai/trùng, độ trễ sau công bố, chi phí/brief và chi phí/người dùng hoạt động. Không dùng lượt click làm thước đo duy nhất.

Nếu nghiên cứu tín hiệu ở giai đoạn sau: point-in-time universe, delisted assets, corporate actions, split theo thời gian, walk-forward/holdout, transaction costs và nhật ký mọi thử nghiệm. Backtest và paper trading phải được ghi riêng; chưa chứng minh alpha hoặc lợi nhuận thật.

Review nội bộ hàng tuần: dự báo/thesis nào sai, vì dữ kiện sai hay mô hình sai; nguồn nào thay đổi; bằng chứng nào buộc rút lại. Tách vai trò tác giả và người duyệt cho nhận định ảnh hưởng lớn. Đặt chế độ chỉ hiện dữ kiện khi lớp phân tích hỏng.

## 9. Tham khảo dài hạn — giả định nhân sự cũ, đã thay bằng chế độ solo

- Product/analyst: chọn câu hỏi thực, định nghĩa relevance, thẩm định nguồn và brief.
- Data/backend engineer: adapters, revisions, identity, scheduling, observability.
- Full-stack engineer: workflow nghiên cứu, citations, mobile, accessibility.
- Reviewer bán thời gian: phản biện phương pháp, rủi ro mô hình và phạm vi sử dụng dữ liệu.

Ngân sách cần tách: nhân sự + quyền dữ liệu + DB/storage/compute + AI + giám sát + review chuyên môn. Chưa có báo giá provider hoặc telemetry nên chưa thể chốt tổng tiền. Công thức dự toán tháng: chi phí cố định + số lượt ingest × chi phí ingest + số brief × chi phí inference/review + lưu trữ raw/version + quyền phân phối theo hợp đồng. Đo 14 ngày và lấy ít nhất hai phương án provider đáp ứng cùng yêu cầu trước khi mua.

Thứ tự phát hành: nội bộ → pilot có người duyệt → bản nghiên cứu cho người dùng → module danh mục nếu cổng dữ liệu đạt. Bản phổ thông vẫn nhận bản tin và tác động cuộc sống; khả năng trả phí của bàn nghiên cứu/nhóm analyst cần kiểm chứng bằng pilot, chưa coi là product-market fit.

## 10. Gói triển khai đầu tiên: Evidence Quality Gate

**Thất bại cần giải quyết:** câu đúng con số nhưng sai ý nghĩa có thể qua bộ kiểm tra hiện tại.

**Phạm vi 1 sprint đề xuất:** `lib/ask.ts`, `lib/claims.ts`, `lib/db/read.ts` và tests liên quan; đồng bộ WIP trước khi sửa read model. Không mở rộng provider, không làm danh mục, không thay DB production trong gói đánh giá đầu tiên.

1. Tạo 30 trường hợp có source excerpts và đáp án/abstention được gán nhãn: đổi chủ thể, sai kỳ, đảo chiều, phủ định, nhân quả không hỗ trợ, mâu thuẫn, thiếu dữ kiện và câu hợp lệ.
2. Chạy baseline bộ kiểm tra hiện tại; lưu failure cases và phân biệt lỗi prompt với lỗi acceptance gate.
3. Đề xuất claim-level output có evidence IDs; validator kiểm tra identity/unit/time và trích đoạn. Với hàm ý chưa chứng minh được, dùng extractive response hoặc abstention; thêm semantic review có đánh giá riêng nếu cần.
4. Đo coverage lẫn precision trên holdout. Reviewer xác nhận toàn bộ phát biểu trọng yếu của corpus; không tuyên bố validator giải quyết mọi hallucination.
5. Chạy `npm run typecheck`, `npm run typecheck:scripts` nếu sửa script, `npm test`, `npm run build`; kiểm tra workflow trình duyệt khi thay UI.

**Exit:** không nhận các phản ví dụ trọng yếu trong corpus, giữ ≥90% câu hợp lệ được trả lời đúng trên tập đã gán nhãn, có báo cáo baseline/after và các lỗi còn mở. Đây là tiêu chí chấp nhận đề xuất, không phải kết quả hiện tại.

## 11. Nguồn công khai đã tra cứu

[S1] BlackRock, Aladdin Risk: https://www.blackrock.com/aladdin/platforms/products/aladdin-risk

[S2] J.P. Morgan Markets: https://www.jpmorgan.com/markets

[S3] Bridgewater, mô tả phương pháp: https://www.bridgewater.com/ ; nghiên cứu: https://www.bridgewater.com/research-and-insights

[S4] Two Sigma, Businesses: https://www.twosigma.com/businesses/

[S5] NBIM, Market Risk Management: https://www.nbim.no/en/about-us/about-the-fund/governance-structure/policies/market-risk-management/

[S6] Bloomberg, Data Connectivity: https://professional.bloomberg.com/products/data/data-connectivity/

[S7] FRED, Real-Time Periods: https://fred.stlouisfed.org/docs/api/fred/realtime_period.html ; observations: https://fred.stlouisfed.org/docs/api/fred/series_observations.html

[S8] SEC, Developer Resources: https://www.sec.gov/about/developer-resources

[S9] Cục Thống kê, báo cáo kinh tế xã hội: https://www.nso.gov.vn/bao-cao-tinh-hinh-kinh-te-xa-hoi-hang-thang/

Các nguồn xác nhận năng lực/phương pháp hoặc điểm truy cập công khai tại ngày nghiên cứu; không xác nhận khả năng truy cập hợp đồng, API trả phí hay quyền tái phân phối của ThunderFeed.
