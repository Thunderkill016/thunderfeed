/**
 * Entity seed generator — emits db/migrations/0013_entity_seed.sql from
 * the gazetteer's canonical registry (lib/entities.ts CANONICAL) plus the
 * curated maps below. Regenerate after gazetteer changes:
 *   npx tsx scripts/gen-entity-seed.mts
 * The output is plain INSERT/UPDATE SQL so pg-mem test fixtures apply it
 * identically to production.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalEntity,
  entityLabel,
  gazetteerEntries,
} from "../lib/entities";
import { normalizeText } from "../lib/model";

/* ---- curated seed maps ------------------------------------------------ */

/* ISO 3166-1 codes for country-type entities — stable authoritative data. */
const ISO: Record<string, [a2: string, a3: string]> = {
  vietnam: ["VN", "VNM"],
  china: ["CN", "CHN"],
  japan: ["JP", "JPN"],
  southkorea: ["KR", "KOR"],
  northkorea: ["KP", "PRK"],
  taiwan: ["TW", "TWN"],
  thailand: ["TH", "THA"],
  myanmar: ["MM", "MMR"],
  laos: ["LA", "LAO"],
  cambodia: ["KH", "KHM"],
  malaysia: ["MY", "MYS"],
  singapore: ["SG", "SGP"],
  indonesia: ["ID", "IDN"],
  philippines: ["PH", "PHL"],
  india: ["IN", "IND"],
  pakistan: ["PK", "PAK"],
  bangladesh: ["BD", "BGD"],
  australia: ["AU", "AUS"],
  newzealand: ["NZ", "NZL"],
  israel: ["IL", "ISR"],
  palestine: ["PS", "PSE"],
  iran: ["IR", "IRN"],
  iraq: ["IQ", "IRQ"],
  syria: ["SY", "SYR"],
  lebanon: ["LB", "LBN"],
  yemen: ["YE", "YEM"],
  saudi: ["SA", "SAU"],
  uae: ["AE", "ARE"],
  qatar: ["QA", "QAT"],
  turkey: ["TR", "TUR"],
  russia: ["RU", "RUS"],
  ukraine: ["UA", "UKR"],
  uk: ["GB", "GBR"],
  france: ["FR", "FRA"],
  germany: ["DE", "DEU"],
  italy: ["IT", "ITA"],
  spain: ["ES", "ESP"],
  poland: ["PL", "POL"],
  netherlands: ["NL", "NLD"],
  belgium: ["BE", "BEL"],
  switzerland: ["CH", "CHE"],
  sweden: ["SE", "SWE"],
  norway: ["NO", "NOR"],
  denmark: ["DK", "DNK"],
  finland: ["FI", "FIN"],
  austria: ["AT", "AUT"],
  greece: ["GR", "GRC"],
  portugal: ["PT", "PRT"],
  ireland: ["IE", "IRL"],
  hungary: ["HU", "HUN"],
  czech: ["CZ", "CZE"],
  romania: ["RO", "ROU"],
  us: ["US", "USA"],
  canada: ["CA", "CAN"],
  mexico: ["MX", "MEX"],
  brazil: ["BR", "BRA"],
  argentina: ["AR", "ARG"],
  chile: ["CL", "CHL"],
  peru: ["PE", "PER"],
  colombia: ["CO", "COL"],
  venezuela: ["VE", "VEN"],
  cuba: ["CU", "CUB"],
  panama: ["PA", "PAN"],
  haiti: ["HT", "HTI"],
  egypt: ["EG", "EGY"],
  southafrica: ["ZA", "ZAF"],
  nigeria: ["NG", "NGA"],
  kenya: ["KE", "KEN"],
  sudan: ["SD", "SDN"],
  ethiopia: ["ET", "ETH"],
  morocco: ["MA", "MAR"],
  libya: ["LY", "LBY"],
  congo: ["CD", "COD"],
  southsudan: ["SS", "SSD"],
};

/* SEC CIK identifiers — lifted verbatim from lib/adapters/secEdgar.ts's
 * issuer universe (existing primary-document data, not invented). */
const CIK: Record<string, string> = {
  "company:apple": "0000320193",
  "company:microsoft": "0000789019",
  "company:alphabet": "0001652044",
  "company:meta_platforms": "0001326801",
  "company:nvidia": "0001045810",
  "company:tesla": "0001318605",
  "company:intel": "0000050863",
  "company:amazon": "0001018724",
  "company:amd": "0000002488",
  "company:oracle": "0001341439",
};

/* Brand/product aliases that resolve to a company — flagged in the audit;
 * they stay aliases of the company entity at alias_type='brand_name'. */
const BRAND_ALIASES = new Set([
  "chatgpt",
  "claude",
  "starlink",
  "falcon",
  "tiktok",
  "facebook",
  "deepmind",
  "green sm",
]);

/* Canonical nodes that are NOT gazetteer slugs — brand products and the
 * remaining SEC issuers our evidence pipeline already sees. */
const EXTRA_ENTITIES: {
  key: string;
  name: string;
  type: string;
  aliases: string[];
  country?: string;
  identifiers?: [scheme: string, value: string][];
}[] = [
  { key: "brand:google", name: "Google", type: "brand", aliases: ["google"] },
  {
    key: "brand:facebook",
    name: "Facebook",
    type: "brand",
    aliases: ["facebook"],
  },
  { key: "brand:tiktok", name: "TikTok", type: "brand", aliases: ["tiktok"] },
  {
    key: "brand:chatgpt",
    name: "ChatGPT",
    type: "brand",
    aliases: ["chatgpt"],
  },
  { key: "brand:claude", name: "Claude", type: "brand", aliases: ["claude"] },
  {
    key: "brand:starlink",
    name: "Starlink",
    type: "brand",
    aliases: ["starlink"],
  },
  {
    key: "brand:green_sm",
    name: "Green SM",
    type: "brand",
    aliases: ["green sm"],
  },
  {
    key: "brand:deepmind",
    name: "DeepMind",
    type: "brand",
    aliases: ["deepmind"],
  },
  {
    key: "company:amazon",
    name: "Amazon.com, Inc.",
    type: "company",
    aliases: ["amazon", "amazon.com"],
    country: "US",
    identifiers: [["cik", "0001018724"]],
  },
  {
    key: "company:amd",
    name: "Advanced Micro Devices, Inc.",
    type: "company",
    aliases: ["amd", "advanced micro devices"],
    country: "US",
    identifiers: [["cik", "0000002488"]],
  },
  {
    key: "company:oracle",
    name: "Oracle Corp.",
    type: "company",
    aliases: ["oracle"],
    country: "US",
    identifiers: [["cik", "0001341439"]],
  },
];

/* Explicit relationships — only edges that are stable, public and
 * evidence-free to state (brand→company, institution HQ country).
 * Co-occurrence is NEVER asserted here. */
const RELATIONSHIPS: [from: string, type: string, to: string][] = [
  ["brand:google", "brand_of", "company:alphabet"],
  ["brand:deepmind", "brand_of", "company:alphabet"],
  ["brand:facebook", "brand_of", "company:meta_platforms"],
  ["brand:tiktok", "brand_of", "company:bytedance"],
  ["brand:chatgpt", "brand_of", "company:openai"],
  ["brand:claude", "brand_of", "company:anthropic"],
  ["brand:starlink", "brand_of", "company:spacex"],
  ["brand:green_sm", "brand_of", "company:vinfast"],
  ["central_bank:fed", "headquartered_in", "country:us"],
  ["central_bank:sbv", "headquartered_in", "country:vietnam"],
  ["central_bank:boj", "headquartered_in", "country:japan"],
];

/* The SEC issuer-name → canonical key lookup: filings carry issuer names
 * like "NVIDIA Corp." which must resolve for the issuer-linkage path. */
const SEC_ISSUER_NAME_TO_KEY: Record<string, string> = {
  "Apple Inc.": "company:apple",
  "Microsoft Corp.": "company:microsoft",
  "Alphabet Inc.": "company:alphabet",
  "Meta Platforms, Inc.": "company:meta_platforms",
  "NVIDIA Corp.": "company:nvidia",
  "Tesla, Inc.": "company:tesla",
  "Intel Corp.": "company:intel",
  "Amazon.com, Inc.": "company:amazon",
  "Advanced Micro Devices, Inc.": "company:amd",
  "Oracle Corp.": "company:oracle",
};

/* --------------------------------------------------------------------- */

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function viEn(alias: string): string | null {
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(
    alias,
  )
    ? "vi"
    : /^[\x20-\x7e]+$/.test(alias)
      ? "en"
      : null;
}

function aliasType(alias: string): string {
  if (BRAND_ALIASES.has(alias.toLowerCase())) return "brand_name";
  if (
    /^[A-Z0-9]{2,6}$/.test(alias) ||
    (/^[a-z]{2,5}$/.test(alias) === false &&
      alias.length <= 6 &&
      alias === alias.toUpperCase())
  )
    return "abbreviation";
  return "common_name";
}

const sql: string[] = [];
sql.push("BEGIN;");
sql.push("");
sql.push("-- 0013: entity seed — GENERATED by scripts/gen-entity-seed.mts.");
sql.push("-- Every gazetteer slug becomes a canonical entity; aliases carry");
sql.push("-- the matching surface so lookup never re-derives identity from");
sql.push("-- raw text. Unmapped legacy junction slugs get 'unresolved'");
sql.push("-- entities instead of silently passing.");
sql.push("");

const slugKeyPairs: [string, string][] = [];
const entityInserts: string[] = [];
const identInserts: string[] = [];

/* aliases keyed (entity_key, normalized) — surface forms that normalize
 * identically ('việt nam'/'viet nam', 'Tesla, Inc.'/'tesla inc') are the
 * SAME alias and the (entity_id, normalized_alias) unique key enforces
 * it. Keep the most informative surface: official/legal > brand >
 * transliteration-diacritic > plain. */
const aliasRank = (t: string, surface: string) =>
  (t === "official_name" ? 0 : t === "brand_name" ? 1 : 2) +
  (/[^\x00-\x7f]/.test(surface) ? -0.5 : 0);
const ALIAS_SEP = String.fromCharCode(1);
const aliasRows = new Map<
  string,
  { alias: string; type: string; lang: string | null; rank: number }
>();
function addAlias(
  key: string,
  alias: string,
  type: string,
  lang: string | null,
) {
  const norm = normalizeText(alias);
  const k = `${key}${ALIAS_SEP}${norm}`;
  const rank = aliasRank(type, alias);
  const prev = aliasRows.get(k);
  if (!prev || rank < prev.rank) aliasRows.set(k, { alias, type, lang, rank });
}

for (const def of gazetteerEntries()) {
  const canon = canonicalEntity(def.slug);
  if (!canon) continue;
  slugKeyPairs.push([def.slug, canon.key]);
  const iso = ISO[def.slug];
  const name = canon.name ?? entityLabel(def.slug);
  entityInserts.push(
    `(${q(canon.key)}, ${q(name)}, ${q(canon.type)}, 'active', ` +
      `${iso ? q(iso[0]) : "NULL"}, ` +
      `${q(JSON.stringify({ gazetteerSlug: def.slug, ambiguity: canon.ambiguity ?? null }))}::jsonb)`,
  );
  for (const a of def.aliases) addAlias(canon.key, a, aliasType(a), viEn(a));
  if (iso) {
    identInserts.push(
      `((SELECT id FROM entities WHERE canonical_key = ${q(canon.key)}), 'iso_country', ${q(iso[1])}, NULL, '{}'::jsonb)`,
    );
  }
  if (CIK[canon.key]) {
    identInserts.push(
      `((SELECT id FROM entities WHERE canonical_key = ${q(canon.key)}), 'cik', ${q(CIK[canon.key])}, NULL, '{}'::jsonb)`,
    );
  }
}

/* SEC issuer-name aliases so filings resolve by name too */
for (const [issuerName, key] of Object.entries(SEC_ISSUER_NAME_TO_KEY)) {
  if (
    slugKeyPairs.some(([, k]) => k === key) ||
    EXTRA_ENTITIES.some((e) => e.key === key)
  ) {
    addAlias(key, issuerName, "official_name", "en");
  }
}

for (const e of EXTRA_ENTITIES) {
  entityInserts.push(
    `(${q(e.key)}, ${q(e.name)}, ${q(e.type)}, 'active', ` +
      `${e.country ? q(e.country) : "NULL"}, '{}'::jsonb)`,
  );
  for (const a of e.aliases) addAlias(e.key, a, "common_name", viEn(a));
  for (const [scheme, value] of e.identifiers ?? []) {
    identInserts.push(
      `((SELECT id FROM entities WHERE canonical_key = ${q(e.key)}), ${q(scheme)}, ${q(value)}, NULL, '{}'::jsonb)`,
    );
  }
}

const aliasInserts = [...aliasRows.entries()].map(([k, r]) => {
  const key = k.slice(0, k.indexOf(ALIAS_SEP));
  return (
    `((SELECT id FROM entities WHERE canonical_key = ${q(key)}), ` +
    `${q(r.alias)}, ${q(normalizeText(r.alias))}, ` +
    `${r.lang ? q(r.lang) : "NULL"}, ${q(r.type)})`
  );
});

sql.push(
  "INSERT INTO entities (canonical_key, canonical_name, entity_type, status, country_code, metadata) VALUES",
);
sql.push(entityInserts.join(",\n") + ";");
sql.push("");
sql.push(
  "INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language, alias_type) VALUES",
);
sql.push(aliasInserts.join(",\n") + ";");
sql.push("");
sql.push(
  "INSERT INTO entity_identifiers (entity_id, scheme, value, issuer, metadata) VALUES",
);
sql.push(identInserts.join(",\n") + ";");
sql.push("");

/* explicit relationships — source_method 'curated' marks them as
 * hand-asserted structure, not extracted evidence */
sql.push(
  "INSERT INTO entity_relationships (from_entity_id, to_entity_id, relationship_type, source_method) VALUES",
);
sql.push(
  RELATIONSHIPS.map(
    ([f, t, to]) =>
      `((SELECT id FROM entities WHERE canonical_key = ${q(f)}), ` +
      `(SELECT id FROM entities WHERE canonical_key = ${q(to)}), ${q(t)}, 'curated')`,
  ).join(",\n") + ";",
);
sql.push("");

/* event_entities.entity_id backfill — one explicit statement per
 * gazetteer slug. Auditable line-by-line (a slug's mapping is a
 * reviewable row, not a hidden join) and works on every postgres-
 * compatible engine, including pg-mem which cannot host UPDATE…FROM. */
sql.push("-- event_entities.entity_id backfill — explicit per-slug so");
sql.push("-- every existing junction row's mapping is auditable");
sql.push(
  slugKeyPairs
    .map(
      ([s, k]) =>
        `UPDATE event_entities SET entity_id = ` +
        `(SELECT id FROM entities WHERE canonical_key = ${q(k)}) ` +
        `WHERE entity_slug = ${q(s)} AND entity_id IS NULL;`,
    )
    .join("\n"),
);
sql.push("");

/* legacy junction slugs outside the gazetteer (drifted taxonomy rows on
 * production) get 'unresolved' entities — documented, queryable, never
 * silently dropped. UPDATE…FROM/jsonb_build_object are real-postgres
 * only; test fixtures have no junction rows at migration time so the
 * PG-ONLY strip loses nothing. */
sql.push("-- == PG-ONLY:");
sql.push(`-- legacy junction slugs outside the gazetteer become 'unresolved'
-- entities — documented, queryable, never silently dropped
INSERT INTO entities (canonical_key, canonical_name, entity_type, status, metadata)
SELECT 'legacy:' || s.entity_slug, s.entity_slug, 'other', 'unresolved',
       jsonb_build_object('unresolved', true, 'legacySlug', s.entity_slug)
FROM (SELECT DISTINCT entity_slug FROM event_entities) s
LEFT JOIN entities en ON en.canonical_key = 'legacy:' || s.entity_slug
     OR en.metadata->>'gazetteerSlug' = s.entity_slug
WHERE en.id IS NULL
  AND s.entity_slug NOT IN (${slugKeyPairs.map(([x]) => q(x)).join(",")})
ON CONFLICT (canonical_key) DO NOTHING;

UPDATE event_entities ee
SET entity_id = en.id
FROM entities en
WHERE ee.entity_id IS NULL
  AND en.canonical_key = 'legacy:' || ee.entity_slug;`);

sql.push("");
sql.push("COMMIT;");
sql.push("");

const out = fileURLToPath(
  new URL("../db/migrations/0013_entity_seed.sql", import.meta.url),
);
writeFileSync(out, sql.join("\n"));
console.log(
  `wrote ${out} — ${entityInserts.length} entities, ${aliasInserts.length} aliases, ${identInserts.length} identifiers, ${RELATIONSHIPS.length} relationships`,
);
