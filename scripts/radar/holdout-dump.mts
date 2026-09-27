/* Holdout dump — fresh unlabeled radar candidates for evaluation.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/holdout-dump.mts [--out path] [--events N] [--deltas N]
 *   (default: tests/fixtures/radar-holdout.json, 150 events, 60 deltas)
 *
 * The labeled corpus (radar-corpus.json) is DEV data — its labels have
 * shaped tuning. This dump is the HOLDOUT: q='unlabeled' so bench.mts
 * still ranks items but excludes them from P@K/noise denominators and
 * prints the top-10 for blind review. Label AFTER looking, not while
 * tuning. Rerun on future windows for a forward test.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getLatestDataDeltas, getRecentEvents } from "../../lib/db/read.ts";

const args = process.argv.slice(2);
const num = (flag: string, d: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const EVENTS = num("--events", 150);
const DELTAS = num("--deltas", 60);
const outIdx = args.indexOf("--out");
const OUT =
  outIdx >= 0
    ? args[outIdx + 1]
    : fileURLToPath(
        new URL("../../tests/fixtures/radar-holdout.json", import.meta.url),
      );

const deltas = await getLatestDataDeltas(DELTAS);
const events = await getRecentEvents(EVENTS);

const items = [
  ...deltas.map((d, i) => ({
    ref: `D${String(i).padStart(3, "0")}`,
    kind: "delta" as const,
    q: "unlabeled",
    relevantTo: [] as string[],
    data: d,
  })),
  ...events.map((e, i) => ({
    ref: `E${String(i).padStart(3, "0")}`,
    kind: "event" as const,
    q: "unlabeled",
    relevantTo: [] as string[],
    data: e,
  })),
];

writeFileSync(
  OUT,
  JSON.stringify(
    {
      note: "HOLDOUT — unlabeled. Rank with bench.mts --corpus; label blind, never tune first.",
      dumpedAt: new Date().toISOString(),
      items,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `holdout: ${deltas.length} deltas + ${events.length} events → ${OUT}`,
);
process.exit(0);
