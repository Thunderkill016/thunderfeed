/**
 * Entity audit — exports every gazetteer slug with its current label,
 * kind and the canonical identity it migrates to. The report is the
 * conflation record the identity migration works from:
 *   npx tsx scripts/bench/entity-audit.ts
 * writes bench/entity-audit.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalEntity,
  entityKind,
  entityLabel,
  gazetteerEntries,
} from "../../lib/entities";

interface AuditRow {
  slug: string;
  currentLabel: string;
  currentKind: string | null;
  proposedCanonicalKey: string | null;
  proposedCanonicalType: string | null;
  aliases: string[];
  ambiguity: string | null;
  notes: string;
}

const rows: AuditRow[] = gazetteerEntries().map((d) => {
  const canon = canonicalEntity(d.slug);
  const notes: string[] = [];
  if (!canon) notes.push("NO canonical identity — must resolve before seed");
  if (canon && canon.type === "company") {
    const personish = d.aliases.filter(
      (a) => /\s/.test(a) && /^[A-ZÀ-Ý]/.test(a),
    );
    if (personish.length)
      notes.push(`possible person-name aliases: ${personish.join(", ")}`);
  }
  return {
    slug: d.slug,
    currentLabel: entityLabel(d.slug),
    currentKind: entityKind(d.slug),
    proposedCanonicalKey: canon?.key ?? null,
    proposedCanonicalType: canon?.type ?? null,
    aliases: d.aliases,
    ambiguity: canon?.ambiguity ?? null,
    notes: notes.join("; "),
  };
});

const summary = {
  totalSlugs: rows.length,
  mapped: rows.filter((r) => r.proposedCanonicalKey !== null).length,
  unmapped: rows.filter((r) => r.proposedCanonicalKey === null).length,
  ambiguous: rows.filter((r) => r.ambiguity !== null).length,
  byType: rows.reduce<Record<string, number>>((m, r) => {
    const t = r.proposedCanonicalType ?? "unmapped";
    m[t] = (m[t] ?? 0) + 1;
    return m;
  }, {}),
};

const out = fileURLToPath(
  new URL("../../bench/entity-audit.json", import.meta.url),
);
mkdirSync(fileURLToPath(new URL("../../bench", import.meta.url)), {
  recursive: true,
});
writeFileSync(out, JSON.stringify({ summary, entities: rows }, null, 2));
console.log(`wrote ${out}`);
console.log(JSON.stringify(summary, null, 2));
console.log(
  "ambiguous:",
  rows
    .filter((r) => r.ambiguity)
    .map((r) => `${r.slug} → ${r.ambiguity}`)
    .join("\n  "),
);
