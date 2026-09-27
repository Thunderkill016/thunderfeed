/** Cross-surface navigation. The product is the radar — one morning
 *  screen; the other lenses (edition, deltas, instruments, search)
 *  orbit it. Legacy surfaces (/ask, /watch, /sources, /entity) stay
 *  routable but are off the primary nav. */
export default function SiteNav({
  active,
}: {
  active?:
    | "news"
    | "macro"
    | "markets"
    | "radar"
    | "sources"
    | "ask"
    | "watch"
    | "search";
}) {
  return (
    <nav className="site-nav" aria-label="Sản phẩm">
      <a
        href="/"
        className={active === "radar" ? "site-nav-item on" : "site-nav-item"}
      >
        Radar
      </a>
      <a
        href="/edition"
        className={active === "news" ? "site-nav-item on" : "site-nav-item"}
      >
        Bản tin
      </a>
      <a
        href="/macro"
        className={active === "macro" ? "site-nav-item on" : "site-nav-item"}
      >
        Tín hiệu
      </a>
      <a
        href="/instrument"
        className={active === "markets" ? "site-nav-item on" : "site-nav-item"}
      >
        Dữ liệu
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
