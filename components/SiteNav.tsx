/** Cross-surface navigation — the product's three lenses on the same
 *  canonical graph: news events, macro data, instruments. */
export default function SiteNav({
  active,
}: {
  active?:
    "news" | "macro" | "markets" | "sources" | "ask" | "watch" | "search";
}) {
  return (
    <nav className="site-nav" aria-label="Sản phẩm">
      <a
        href="/ask"
        className={active === "ask" ? "site-nav-item on" : "site-nav-item"}
      >
        Hỏi đáp
      </a>
      <a
        href="/"
        className={active === "news" ? "site-nav-item on" : "site-nav-item"}
      >
        Tin tức
      </a>
      <a
        href="/macro"
        className={active === "macro" ? "site-nav-item on" : "site-nav-item"}
      >
        Vĩ mô
      </a>
      <a
        href="/instrument"
        className={active === "markets" ? "site-nav-item on" : "site-nav-item"}
      >
        Chứng khoán
      </a>
      <a
        href="/watch"
        className={active === "watch" ? "site-nav-item on" : "site-nav-item"}
      >
        Theo dõi
      </a>
      <a
        href="/sources"
        className={active === "sources" ? "site-nav-item on" : "site-nav-item"}
      >
        Nguồn
      </a>
      <a
        href="/search"
        className={active === "search" ? "site-nav-item on" : "site-nav-item"}
      >
        Tìm
      </a>
    </nav>
  );
}
