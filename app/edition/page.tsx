import { getEdition } from "../../lib/edition";
import Edition from "../../components/Edition";
import { ReliabilityProvider } from "../../components/ReliabilityContext";

/* ISR, not force-dynamic: the client polls /api/edition for freshness
   anyway, so serving CDN-cached HTML is strictly better than paying a
   1.4MB SSR render per pageview. Revalidate re-runs getEdition(), which
   is a warm-memory or single-snapshot read — never a build. */
export const revalidate = 60;
export const maxDuration = 60;

export default async function Page() {
  const edition = await getEdition();
  return (
    <ReliabilityProvider>
      <Edition initial={edition} />
    </ReliabilityProvider>
  );
}
