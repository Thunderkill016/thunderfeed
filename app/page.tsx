import { getEdition } from "../lib/edition";
import Edition from "../components/Edition";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function Page() {
  const edition = await getEdition();
  return <Edition initial={edition} />;
}
