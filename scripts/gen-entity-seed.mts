/**
 * Entity seed generator — emits db/migrations/0015_entity_seed_v2.sql
 * from the gazetteer's canonical registry (lib/entities.ts CANONICAL)
 * plus the curated maps below. Regenerate after gazetteer changes:
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

/* Surfaces that are brand/product names — tagged alias_type='brand_name'
 * wherever they land. Since V1.1 they resolve to their own brand
 * entities (gazetteer slugs google/facebook/tiktok/chatgpt/claude/
 * starlink/falcon/deepmind/greensm), never silently to the issuer. */
const BRAND_ALIASES = new Set([
  "chatgpt",
  "chat gpt",
  "claude",
  "claude ai",
  "starlink",
  "falcon",
  "falcon 9",
  "falcon heavy",
  "tiktok",
  "tik tok",
  "facebook",
  "google",
  "deepmind",
  "google deepmind",
  "green sm",
  "green s.m",
  "xanh sm",
]);

/* Canonical nodes that are NOT gazetteer slugs — SEC issuers our
 * evidence pipeline already sees but whose names never anchor a news
 * cluster. Brand entities live in the gazetteer since V1.1. */
const EXTRA_ENTITIES: {
  key: string;
  name: string;
  type: string;
  aliases: string[];
  country?: string;
  identifiers?: [scheme: string, value: string][];
}[] = [
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

/* Explicit relationships — every edge carries the authoritative evidence
 * behind it (Phase 8): provider + source document + observed_at + method.
 * `supersedes` names the V1.1 curated assertion this edge replaces —
 * corrections append, never rewrite. Co-occurrence is NEVER asserted. */
interface RelSeed {
  from: string;
  type: string;
  to: string;
  prov: Record<string, string>;
  /** the V1.1 assertion this supersedes (same or corrected edge) */
  supersedes?: { from: string; type: string; to: string };
}

const OBSERVED = "2026-09-26";
const SEC = (note: string) => ({
  provider: "SEC EDGAR",
  method: "registry_filing",
  sourceUrl:
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=10-K",
  observedAt: OBSERVED,
  note,
});
const OFFICIAL = (provider: string, sourceUrl: string, note: string) => ({
  provider,
  method: "official_disclosure",
  sourceUrl,
  observedAt: OBSERVED,
  note,
});

/* Edges WITHOUT a superseded predecessor are emitted as portable
 * guarded inserts; edges that supersede a V1.1 assertion need a join
 * on entity_relationships, which only real Postgres can evaluate —
 * they land in the PG-ONLY tail (test fixtures provide their own). */
const RELATIONSHIPS: RelSeed[] = [
  {
    /* V1.2: the brand belongs to the operating legal entity, which is
     * itself an Alphabet subsidiary (10-K Exhibit 21) — not directly to
     * Alphabet Inc. */
    from: "brand:google",
    type: "brand_of",
    to: "company:google_llc",
    prov: SEC(
      "Alphabet 10-K: Google LLC is the operating entity behind the Google brand/services",
    ),
    supersedes: {
      from: "brand:google",
      type: "brand_of",
      to: "company:alphabet",
    },
  },
  {
    from: "company:google_llc",
    type: "subsidiary_of",
    to: "company:alphabet",
    prov: SEC(
      "Alphabet 10-K Exhibit 21 lists Google LLC as a subsidiary of Alphabet Inc.",
    ),
  },
  {
    /* Google DeepMind is Google's AI division — inside the Google
     * segment/LLC, not a direct Alphabet child brand */
    from: "brand:deepmind",
    type: "brand_of",
    to: "company:google_llc",
    prov: OFFICIAL(
      "Google DeepMind",
      "https://deepmind.google",
      "DeepMind operates as Google DeepMind within Google",
    ),
    supersedes: {
      from: "brand:deepmind",
      type: "brand_of",
      to: "company:alphabet",
    },
  },
  {
    from: "brand:facebook",
    type: "brand_of",
    to: "company:meta_platforms",
    prov: {
      provider: "SEC EDGAR",
      method: "registry_filing",
      sourceUrl:
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001326801&type=10-K",
      observedAt: OBSERVED,
      note: "Meta Platforms 10-K: Facebook is a product/brand of Meta Platforms, Inc.",
    },
    supersedes: {
      from: "brand:facebook",
      type: "brand_of",
      to: "company:meta_platforms",
    },
  },
  {
    from: "brand:tiktok",
    type: "brand_of",
    to: "company:bytedance",
    prov: OFFICIAL(
      "ByteDance",
      "https://www.bytedance.com/en/",
      "TikTok is a ByteDance product (private co — no SEC filing)",
    ),
    supersedes: {
      from: "brand:tiktok",
      type: "brand_of",
      to: "company:bytedance",
    },
  },
  {
    from: "brand:chatgpt",
    type: "brand_of",
    to: "company:openai",
    prov: OFFICIAL(
      "OpenAI",
      "https://openai.com/chatgpt/",
      "ChatGPT is an OpenAI product",
    ),
    supersedes: {
      from: "brand:chatgpt",
      type: "brand_of",
      to: "company:openai",
    },
  },
  {
    from: "brand:claude",
    type: "brand_of",
    to: "company:anthropic",
    prov: OFFICIAL(
      "Anthropic",
      "https://www.anthropic.com/claude",
      "Claude is an Anthropic product",
    ),
    supersedes: {
      from: "brand:claude",
      type: "brand_of",
      to: "company:anthropic",
    },
  },
  {
    from: "brand:starlink",
    type: "brand_of",
    to: "company:spacex",
    prov: OFFICIAL(
      "SpaceX",
      "https://www.starlink.com/",
      "Starlink is a SpaceX service (site footer/legal terms)",
    ),
    supersedes: {
      from: "brand:starlink",
      type: "brand_of",
      to: "company:spacex",
    },
  },
  {
    from: "brand:falcon",
    type: "brand_of",
    to: "company:spacex",
    prov: OFFICIAL(
      "SpaceX",
      "https://www.spacex.com/vehicles/falcon-9/",
      "Falcon 9/Falcon Heavy are SpaceX vehicles",
    ),
    supersedes: {
      from: "brand:falcon",
      type: "brand_of",
      to: "company:spacex",
    },
  },
  {
    /* V1.2 correction: Xanh SM is operated by Green and Smart Mobility
     * JSC — a separate legal entity. Shared founder (Phạm Nhật Vượng)
     * is NOT ownership evidence, so the old brand_of→vinfast edge was
     * wrong: 'operates' states only what the official site states. */
    from: "company:gsm",
    type: "operates",
    to: "brand:green_sm",
    prov: OFFICIAL(
      "Xanh SM",
      "https://xanhsm.com/",
      "Xanh SM service operated by Công ty Cổ phần Di chuyển Xanh và Thông minh (Green and Smart Mobility JSC)",
    ),
    supersedes: {
      from: "brand:green_sm",
      type: "brand_of",
      to: "company:vinfast",
    },
  },
  {
    from: "central_bank:fed",
    type: "headquartered_in",
    to: "country:us",
    prov: OFFICIAL(
      "Federal Reserve",
      "https://www.federalreserve.gov/",
      "Board of Governors, Washington D.C.",
    ),
    supersedes: {
      from: "central_bank:fed",
      type: "headquartered_in",
      to: "country:us",
    },
  },
  {
    from: "central_bank:sbv",
    type: "headquartered_in",
    to: "country:vietnam",
    prov: OFFICIAL(
      "State Bank of Vietnam",
      "https://sbv.gov.vn/",
      "SBV headquarters, Hanoi",
    ),
    supersedes: {
      from: "central_bank:sbv",
      type: "headquartered_in",
      to: "country:vietnam",
    },
  },
  {
    from: "central_bank:boj",
    type: "headquartered_in",
    to: "country:japan",
    prov: OFFICIAL(
      "Bank of Japan",
      "https://www.boj.or.jp/en/",
      "BOJ headquarters, Tokyo",
    ),
    supersedes: {
      from: "central_bank:boj",
      type: "headquartered_in",
      to: "country:japan",
    },
  },
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
sql.push("-- 0017: entity seed v3 — GENERATED by scripts/gen-entity-seed.mts.");
sql.push("-- Every gazetteer slug becomes a canonical entity; aliases carry");
sql.push("-- the matching surface so lookup never re-derives identity from");
sql.push("-- raw text. V1.2: Google LLC + GSM are canonical legal entities;");
sql.push("-- brand surfaces resolve to BRAND entities (never silently to");
sql.push("-- the issuer); relationships carry authoritative provenance and");
sql.push("-- corrected edges append as superseding assertions (V1.1 rows");
sql.push("-- stay queryable as history). All inserts are idempotent.");
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
      `((SELECT id FROM entities WHERE canonical_key = ${q(canon.key)}), 'iso_country', ${q(iso[1])}, NULL, '{}'::jsonb, ` +
        `'{"provider":"ISO 3166-1","method":"standard_registry"}'::jsonb)`,
    );
  }
  if (CIK[canon.key]) {
    identInserts.push(
      `((SELECT id FROM entities WHERE canonical_key = ${q(canon.key)}), 'cik', ${q(CIK[canon.key])}, NULL, '{}'::jsonb, ` +
        `'{"provider":"SEC EDGAR","method":"registry_seed","note":"EDGAR issuer universe used by the secEdgar adapter"}'::jsonb)`,
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
      `((SELECT id FROM entities WHERE canonical_key = ${q(e.key)}), ${q(scheme)}, ${q(value)}, NULL, '{}'::jsonb, ` +
        `'{"provider":"SEC EDGAR","method":"registry_seed","note":"EDGAR issuer universe used by the secEdgar adapter"}'::jsonb)`,
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
sql.push(
  entityInserts.join(",\n") + "\nON CONFLICT (canonical_key) DO NOTHING;",
);
sql.push("");

/* gazetteer-slug tag: entities that pre-date a slug (brand nodes seeded
 * as extras in V1) adopt the slug in metadata so read paths can map
 * canonical → gazetteer without re-deriving it. Only fills an EMPTY
 * metadata bag — jsonb || is real-postgres-only and an entity carrying
 * other metadata keys is left for a reviewed migration instead. */
sql.push(
  slugKeyPairs
    .map(
      ([s, k]) =>
        `UPDATE entities SET metadata = ` +
        `'{"gazetteerSlug":${JSON.stringify(s)}}'::jsonb ` +
        `WHERE canonical_key = ${q(k)} AND metadata = '{}'::jsonb;`,
    )
    .join("\n"),
);
sql.push("");
sql.push(
  "INSERT INTO entity_aliases (entity_id, alias, normalized_alias, language, alias_type) VALUES",
);
sql.push(aliasInserts.join(",\n") + "\nON CONFLICT DO NOTHING;");
sql.push("");
sql.push(
  "INSERT INTO entity_identifiers (entity_id, scheme, value, issuer, metadata, provenance) VALUES",
);
sql.push(identInserts.join(",\n") + "\nON CONFLICT DO NOTHING;");
sql.push("");

/* explicit relationships — every edge is an append-only assertion with
 * authoritative provenance; a corrected edge links to the V1.1 row it
 * supersedes via supersedes_relationship_id (resolved through the old
 * edge's entities so the SQL stays portable). Rows are assertions (no
 * natural unique key), so idempotency uses a guarded INSERT…SELECT that
 * skips once a live (non-superseded) edge exists. */
const newEdges = RELATIONSHIPS.filter((r) => !r.supersedes);
const corrected = RELATIONSHIPS.filter((r) => r.supersedes);
for (const r of newEdges) {
  sql.push(
    `INSERT INTO entity_relationships\n` +
      `  (from_entity_id, to_entity_id, relationship_type, source_method,\n` +
      `   provenance, valid_from)\n` +
      `SELECT ef.id, et.id, ${q(r.type)}, 'curated', ${q(JSON.stringify(r.prov))}::jsonb,\n` +
      `       ${q(r.prov.observedAt)}::timestamptz\n` +
      `FROM entities ef\n` +
      `JOIN entities et ON true\n` +
      `LEFT JOIN entity_relationships r_new\n` +
      `  ON r_new.from_entity_id = ef.id\n` +
      `  AND r_new.to_entity_id = et.id\n` +
      `  AND r_new.relationship_type = ${q(r.type)}\n` +
      `WHERE ef.canonical_key = ${q(r.from)}\n` +
      `  AND et.canonical_key = ${q(r.to)}\n` +
      `  AND r_new.id IS NULL;`,
  );
}
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
const pgOnly: string[] = [];
pgOnly.push(`-- legacy junction slugs outside the gazetteer become 'unresolved'
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

/* corrected edges live in the PG-ONLY tail — asserting a superseding
 * row requires joining entity_relationships for the predecessor id,
 * and test fixtures (pg-mem) cannot evaluate those joins. On pg-mem
 * the V1.1 edge simply stays live; tests assert the corrected graph
 * through fixture inserts instead. */
for (const r of corrected) {
  const s = r.supersedes!;
  pgOnly.push(
    `-- corrected assertion: ${s.from} -[${s.type}]-> ${s.to}\n` +
      `--   superseded by   ${r.from} -[${r.type}]-> ${r.to}\n` +
      `INSERT INTO entity_relationships\n` +
      `  (from_entity_id, to_entity_id, relationship_type, source_method,\n` +
      `   provenance, supersedes_relationship_id, valid_from)\n` +
      `SELECT ef.id, et.id, ${q(r.type)}, 'curated', ${q(JSON.stringify(r.prov))}::jsonb,\n` +
      `       r_old.id, ${q(r.prov.observedAt)}::timestamptz\n` +
      `FROM entities ef\n` +
      `JOIN entities et ON true\n` +
      `LEFT JOIN entities osf ON osf.canonical_key = ${q(s.from)}\n` +
      `LEFT JOIN entities ost ON ost.canonical_key = ${q(s.to)}\n` +
      `LEFT JOIN entity_relationships r_old\n` +
      `  ON r_old.from_entity_id = osf.id\n` +
      `  AND r_old.to_entity_id = ost.id\n` +
      `  AND r_old.relationship_type = ${q(s.type)}\n` +
      `LEFT JOIN entity_relationships r_sup\n` +
      `  ON r_sup.supersedes_relationship_id = r_old.id\n` +
      `LEFT JOIN entity_relationships r_new\n` +
      `  ON r_new.from_entity_id = ef.id\n` +
      `  AND r_new.to_entity_id = et.id\n` +
      `  AND r_new.relationship_type = ${q(r.type)}\n` +
      `WHERE ef.canonical_key = ${q(r.from)}\n` +
      `  AND et.canonical_key = ${q(r.to)}\n` +
      `  AND r_sup.id IS NULL\n` +
      /* same-triple corrections (provenance upgrade, identical edge):
       * the predecessor itself matches r_new's join — it must NOT count
       * as a duplicate, only a genuinely different live edge blocks */
      `  AND (r_new.id IS NULL OR r_new.id = r_old.id);`,
  );
}
sql.push(pgOnly.join("\n\n"));

sql.push("");
sql.push("COMMIT;");
sql.push("");

const out = fileURLToPath(
  new URL("../db/migrations/0017_entity_seed_v3.sql", import.meta.url),
);
writeFileSync(out, sql.join("\n"));
console.log(
  `wrote ${out} — ${entityInserts.length} entities, ${aliasInserts.length} aliases, ${identInserts.length} identifiers, ${RELATIONSHIPS.length} relationships`,
);
