/** Cross-surface navigation — the product's three lenses on the same
 *  canonical graph: news events, macro data, instruments. */
export default function SiteNav({
  active,
}: {
  active?: "news" | "macro" | "markets";
}) {
  return (
    <nav className="site-nav" aria-label="Sản phẩm">
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
    </nav>
  );
}
