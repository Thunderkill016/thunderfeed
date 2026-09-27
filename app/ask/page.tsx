import type { Metadata } from "next";
import { dbEnabled } from "../../lib/db/pool";
import { answerQuestion } from "../../lib/ask";
import SiteNav from "../../components/SiteNav";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const metadata: Metadata = {
  title: "ThunderFeed — Hỏi đáp",
};

const CONF_VI: Record<string, string> = {
  strong: "mạnh",
  moderate: "vừa",
  weak: "yếu",
};

const STATUS_VI: Record<string, string> = {
  emerging: "mới xuất hiện",
  developing: "đang phát triển",
  steady: "ổn định",
  cooling: "đang nguội",
  resolved: "đã kết thúc",
};

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const canAsk = dbEnabled() && query.length >= 3 && query.length <= 500;
  const result = canAsk ? await answerQuestion(query) : null;

  return (
    <main className="edition macro-page">
      <header className="masthead">
        <div className="masthead-left">
          <a className="wordmark" href="/">
            ThunderFeed
          </a>
          <span className="edition-tag">HỎI ĐÁP</span>
          <SiteNav active="ask" />
        </div>
      </header>

      <section className="macro-group">
        <h2 className="macro-group-title">
          Hỏi về sự kiện ThunderFeed đang theo dõi
        </h2>
        <p className="macro-notes">
          Câu trả lời chỉ được sinh từ bằng chứng chuẩn hoá — mỗi con số phải
          truy được về claim trong graph. Không có bằng chứng → không trả lời.
        </p>
        <form action="/ask" method="get" className="ask-form">
          <input
            type="text"
            name="q"
            defaultValue={query}
            placeholder="VD: lạm phát Mỹ tháng này thế nào?"
            className="ask-input"
            maxLength={500}
            autoComplete="off"
          />
          <button type="submit" className="ask-submit">
            Hỏi
          </button>
        </form>

        {result && (
          <div className="ask-result">
            <div className="ask-answer">
              <p>{result.answer}</p>
              <span className="ask-origin">
                {result.origin === "gemini" ? "model sinh" : "trích xuất"}
              </span>
            </div>
            {result.events.length > 0 && (
              <table className="macro-table">
                <thead>
                  <tr>
                    <th>Sự kiện liên quan</th>
                    <th>Trạng thái</th>
                    <th>Độ tin cậy</th>
                  </tr>
                </thead>
                <tbody>
                  {result.events.map((e) => (
                    <tr key={e.id}>
                      <td className="macro-name">
                        <a className="macro-code" href={`/event/${e.id}`}>
                          {e.title}
                        </a>
                      </td>
                      <td className="macro-date">
                        {STATUS_VI[e.status] ?? e.status}
                      </td>
                      <td className="macro-date">
                        {CONF_VI[e.confidence] ?? e.confidence}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {query && !canAsk && (
          <p className="macro-empty">Câu hỏi phải từ 3–500 ký tự.</p>
        )}
      </section>
    </main>
  );
}
