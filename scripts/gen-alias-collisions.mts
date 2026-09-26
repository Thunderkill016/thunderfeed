/* Phase 9 collision report — normalized aliases shared by >1 entity.
 * These must stay UNRESOLVED (resolve → null); the report documents
 * which surfaces are ambiguous and why. Output: bench/alias-collisions.json */
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const url =
  process.argv[2] ??
  `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(process.env.SUPABASE_DB_PASS!)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const c = new pg.Client({ connectionString: url });
await c.connect();
const { rows } = await c.query<{
  normalized_alias: string;
  canonical_key: string;
  canonical_name: string;
  alias: string;
  alias_type: string;
}>(
  `SELECT a.normalized_alias, e.canonical_key, e.canonical_name,
          a.alias, a.alias_type
   FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
   WHERE a.normalized_alias IN (
     SELECT normalized_alias FROM entity_aliases
     GROUP BY normalized_alias
     HAVING count(DISTINCT entity_id) > 1)
   ORDER BY a.normalized_alias, e.canonical_key`,
);
const byNorm = new Map<
  string,
  {
    entities: string[];
    surfaces: { alias: string; type: string; entity: string }[];
  }
>();
for (const r of rows) {
  const e = byNorm.get(r.normalized_alias) ?? { entities: [], surfaces: [] };
  if (!e.entities.includes(r.canonical_key)) e.entities.push(r.canonical_key);
  e.surfaces.push({
    alias: r.alias,
    type: r.alias_type,
    entity: r.canonical_key,
  });
  byNorm.set(r.normalized_alias, e);
}
const report = {
  generatedAt: new Date().toISOString(),
  normalization:
    "ThunderFeed normalizeText(): lowercase, diacritics stripped, punctuation stripped, whitespace collapsed",
  rule: "normalized aliases shared by >1 entity resolve to NULL — never first-row-wins",
  collisions: [...byNorm.entries()].map(([normalized, v]) => ({
    normalized,
    entities: v.entities,
    surfaces: v.surfaces,
    resolution: "null (ambiguous)",
  })),
};
writeFileSync(
  "bench/alias-collisions.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`${byNorm.size} colliding normalized aliases`);
for (const [n, v] of byNorm) console.log(`  ${n}: ${v.entities.join(" | ")}`);
await c.end();
