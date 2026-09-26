/* Instrument Master seeder — derives instruments/listings/identifiers
 * exclusively from stored reference_observations (SEC + OpenFIGI + ISO MIC).
 *
 *   npx tsx scripts/instruments/seed-master.mts
 *
 * Identity reconciliation: share_class_figi is the identity proof (durable);
 * canonical_key is a label. Conservative promotion — provider disagreement
 * → 'provider_conflict', nothing promoted. Writes
 * bench/instrument-master-v12-audit.json.
 */
import { writeFileSync } from "node:fs";
import {
  deriveSeed,
  parseFigiMappingResponse,
  SEC_EXCHANGE_MIC_CANDIDATES,
  type FigiResult,
} from "../../lib/instruments.ts";
import { applyInstrumentPlan } from "../../lib/db/instruments.ts";
import { connectDb } from "./lib.mts";

type Client = import("pg").Client;

const audit: {
  generatedAt: string;
  instruments: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = { generatedAt: new Date().toISOString(), instruments: [], metrics: {} };

async function latestObs(
  c: Client,
  provider: string,
  dataset: string,
  recordKey: string,
) {
  const r = await c.query(
    `SELECT id, payload, observed_at, retrieved_at FROM reference_observations
      WHERE provider=$1 AND dataset=$2 AND record_key=$3
      ORDER BY retrieved_at DESC`,
    [provider, dataset, recordKey],
  );
  return r.rows;
}

const c = connectDb();
await c.connect();
const conflicts: { issuer: string; ticker: string; reason: string }[] = [];
const unresolved: { issuer: string; ticker: string; reason: string }[] = [];
try {
  // ISO venue observations for venue_reference derivations
  const isoObs = await c.query(
    `SELECT record_key, id FROM reference_observations
      WHERE provider='iso_10383' AND dataset='mic_list'`,
  );
  const venueObsIdByMic = Object.fromEntries(
    isoObs.rows.map((r) => [r.record_key as string, r.id as string]),
  );

  // seed universe: every entity carrying a cik identifier
  const issuers = await c.query(
    `SELECT e.id, e.canonical_key, ei.value AS cik
       FROM entities e JOIN entity_identifiers ei ON ei.entity_id=e.id
      WHERE ei.scheme='cik' AND e.entity_type='company' AND e.status='active'
      ORDER BY e.canonical_key`,
  );
  await c.query("BEGIN");
  // Backfill: version rows written before master_derivations existed carry
  // their asserting observation only in observation_id. Bridge them so the
  // integrity audit's orphan check holds. Idempotent — re-runs are no-ops.
  await c.query(
    `INSERT INTO master_derivations
       (subject_type, instrument_version_id, observation_id, role)
     SELECT 'instrument_version', iv.id, iv.observation_id, 'asserts'
       FROM instrument_versions iv
      WHERE iv.observation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM master_derivations d
         WHERE d.instrument_version_id = iv.id
           AND d.observation_id = iv.observation_id AND d.role='asserts')`,
  );
  await c.query(
    `INSERT INTO master_derivations
       (subject_type, listing_version_id, observation_id, role)
     SELECT 'listing_version', lv.id, lv.observation_id, 'asserts'
       FROM listing_versions lv
      WHERE lv.observation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM master_derivations d
         WHERE d.listing_version_id = lv.id
           AND d.observation_id = lv.observation_id AND d.role='asserts')`,
  );
  await c.query(
    `INSERT INTO master_derivations
       (subject_type, venue_version_id, observation_id, role)
     SELECT 'venue_version', tvv.id, tvv.observation_id, 'asserts'
       FROM trading_venue_versions tvv
      WHERE tvv.observation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM master_derivations d
         WHERE d.venue_version_id = tvv.id
           AND d.observation_id = tvv.observation_id AND d.role='asserts')`,
  );
  for (const iss of issuers.rows) {
    const slug = (iss.canonical_key as string).replace(/^company:/, "");
    const secRows = await c.query(
      `SELECT id, payload FROM reference_observations
        WHERE provider='sec_edgar' AND dataset='company_tickers_exchange'
          AND record_key LIKE $1`,
      [`${iss.cik}:%`],
    );
    for (const s of secRows.rows) {
      const p = s.payload as {
        cik: number;
        name: string;
        ticker: string;
        exchange: string;
      };
      // every candidate venue MIC for this SEC exchange, with its stored
      // OpenFIGI result — a MIC with no observation is simply absent
      const venues: { mic: string; obsId: string; results: FigiResult[] }[] =
        [];
      for (const mic of SEC_EXCHANGE_MIC_CANDIDATES[p.exchange] ?? []) {
        const obs = await latestObs(
          c,
          "openfigi",
          "mapping_v3",
          `${mic}:${p.ticker}`,
        );
        if (!obs.length) continue;
        const parsed = parseFigiMappingResponse(
          (obs[0].payload as { response: unknown }).response,
        );
        if ("error" in parsed) continue;
        venues.push({
          mic,
          obsId: obs[0].id as string,
          results: parsed.results,
        });
      }
      const outcome = deriveSeed({ issuerSlug: slug, secRow: p, venues });
      if (outcome.kind === "conflict") {
        conflicts.push({
          issuer: slug,
          ticker: p.ticker,
          reason: outcome.reason,
        });
        continue;
      }
      if (outcome.kind === "unresolved") {
        unresolved.push({
          issuer: slug,
          ticker: p.ticker,
          reason: outcome.reason,
        });
        continue;
      }
      if (outcome.kind !== "plan") continue; // defensive — 'seeded' never emitted
      const plan = outcome.plan;
      const applied = await applyInstrumentPlan(c, plan, iss.id, {
        // every venue observation asserts the instrument — not one
        // arbitrarily chosen 'figiObsId'
        figiObsIds: [...new Set(plan.listings.map((l) => l.obsId))],
        secObsId: s.id,
        venueObsIdByMic,
      });
      if (applied.kind === "conflict") {
        conflicts.push({
          issuer: slug,
          ticker: p.ticker,
          reason: applied.reason,
        });
        continue;
      }
      const { instrumentId, instrumentVersionId, listingIds } = applied;
      audit.instruments.push({
        issuerEntity: iss.canonical_key,
        instrument: {
          id: instrumentId,
          canonicalKey: plan.instrumentKey,
          name: plan.instrumentName,
          type: plan.instrumentType,
          shareClass: plan.shareClass,
          currency: plan.currency,
          cfi: plan.cfi,
          newVersion: instrumentVersionId != null,
        },
        listings: plan.listings.map((l, i) => ({
          id: listingIds[i],
          canonicalKey: l.listingKey,
          mic: l.mic,
          ticker: l.ticker,
          currency: l.currency,
          figi: l.figi,
        })),
        identifiers: { instrument: plan.instrumentIdentifiers },
        sources: [
          "sec_edgar:company_tickers_exchange",
          "openfigi:mapping_v3",
          "iso_10383:mic_list",
        ],
        observedAt: new Date().toISOString(),
      });
    }
  }

  // ── Phase 10 metrics (inside same connection, pre-commit visible) ──────
  const count = async (q: string, params: unknown[] = []) =>
    Number((await c.query(q, params)).rows[0].n);
  const tickers = await c.query(
    `SELECT lv.ticker, count(DISTINCT l.venue_id) AS venues
       FROM listing_versions lv
       JOIN instrument_listings l ON l.current_version_id = lv.id
      GROUP BY lv.ticker HAVING count(DISTINCT l.venue_id) > 1`,
  );
  const multiSource = await count(
    `SELECT count(*) n FROM (
       SELECT subject_type, coalesce(instrument_id, instrument_version_id,
              listing_id, listing_version_id, venue_id, venue_version_id,
              instrument_identifier_id, listing_identifier_id) AS sid
         FROM master_derivations d
         JOIN reference_observations ro ON ro.id = d.observation_id
        GROUP BY subject_type, sid
       HAVING count(DISTINCT ro.provider) > 1) t`,
  );
  const providerCoverage = async (provider: string) =>
    count(
      `SELECT count(DISTINCT
         coalesce(d.instrument_id::text, d.instrument_version_id::text,
                  d.listing_id::text, d.listing_version_id::text,
                  d.venue_id::text, d.venue_version_id::text,
                  d.instrument_identifier_id::text,
                  d.listing_identifier_id::text)) n
         FROM master_derivations d
         JOIN reference_observations ro ON ro.id = d.observation_id
        WHERE ro.provider = $1`,
      [provider],
    );
  audit.metrics = {
    issuers: issuers.rows.length,
    instruments: await count(`SELECT count(*) n FROM financial_instruments`),
    listings: await count(`SELECT count(*) n FROM instrument_listings`),
    venues: await count(`SELECT count(*) n FROM trading_venues`),
    instrumentVersions: await count(
      `SELECT count(*) n FROM instrument_versions`,
    ),
    listingVersions: await count(`SELECT count(*) n FROM listing_versions`),
    uniqueShareClassFigi: await count(
      `SELECT count(DISTINCT value) n FROM instrument_identifiers WHERE scheme='share_class_figi'`,
    ),
    uniqueCompositeFigi: await count(
      `SELECT count(DISTINCT value) n FROM instrument_identifiers WHERE scheme='composite_figi'`,
    ),
    uniqueVenueFigi: await count(
      `SELECT count(DISTINCT value) n FROM listing_identifiers WHERE scheme='figi'`,
    ),
    cfiDuplicateValues: await count(
      `SELECT count(*) n FROM (
         SELECT cfi FROM instrument_versions WHERE cfi IS NOT NULL
         GROUP BY cfi HAVING count(DISTINCT instrument_id) > 1) t`,
    ),
    recordsWithSecProvenance: await providerCoverage("sec_edgar"),
    recordsWithOpenFigiProvenance: await providerCoverage("openfigi"),
    recordsWithIsoProvenance: await providerCoverage("iso_10383"),
    multiSourceDerivationSubjects: multiSource,
    // primary-listing certainty: historical counts cover every version row
    // (V1 wrote is_primary_listing=true — those are historical corrections,
    // not current certainty); current counts read only live versions.
    historicalPrimaryKnown: await count(
      `SELECT count(*) n FROM listing_versions WHERE is_primary_listing IS NOT NULL`,
    ),
    historicalPrimaryUnknown: await count(
      `SELECT count(*) n FROM listing_versions WHERE is_primary_listing IS NULL`,
    ),
    currentPrimaryKnown: await count(
      `SELECT count(*) n FROM listing_versions lv
         JOIN instrument_listings l ON l.current_version_id = lv.id
        WHERE lv.is_primary_listing IS NOT NULL`,
    ),
    currentPrimaryUnknown: await count(
      `SELECT count(*) n FROM listing_versions lv
         JOIN instrument_listings l ON l.current_version_id = lv.id
        WHERE lv.is_primary_listing IS NULL`,
    ),
    // ── integrity (all target 0) ───────────────────────────────────────
    integrity: {
      // subject_type must agree with the non-null subject FK (also
      // DB-enforced by master_derivations_subject_fk_match)
      badSubjectTypeFkRows: await count(
        `SELECT count(*) n FROM master_derivations WHERE
           (subject_type='instrument' AND instrument_id IS NULL)
        OR (subject_type='instrument_version' AND instrument_version_id IS NULL)
        OR (subject_type='listing' AND listing_id IS NULL)
        OR (subject_type='listing_version' AND listing_version_id IS NULL)
        OR (subject_type='venue' AND venue_id IS NULL)
        OR (subject_type='venue_version' AND venue_version_id IS NULL)
        OR (subject_type='instrument_identifier' AND instrument_identifier_id IS NULL)
        OR (subject_type='listing_identifier' AND listing_identifier_id IS NULL)`,
      ),
      // a version row directly attributed to an observation but missing a
      // matching derivation = provenance gap
      orphanObservations: await count(
        `SELECT count(*) n FROM (
           SELECT iv.observation_id oid, iv.id sid FROM instrument_versions iv
           UNION ALL
           SELECT lv.observation_id, lv.id FROM listing_versions lv
           UNION ALL
           SELECT tvv.observation_id, tvv.id FROM trading_venue_versions tvv
         ) v
         WHERE v.oid IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM master_derivations d
            WHERE d.observation_id = v.oid
              AND (d.instrument_version_id = v.sid
               OR d.listing_version_id = v.sid
               OR d.venue_version_id = v.sid))`,
      ),
      instrumentIdentityConflicts: conflicts.filter((r) =>
        /share_class_figi_(issuer|type)_mismatch|canonical_key_/.test(r.reason),
      ).length,
      listingIdentityConflicts: conflicts.filter((r) =>
        r.reason.startsWith("listing_identity_conflict"),
      ).length,
      // instrument header type must equal the live version's type
      currentTypeMismatches: await count(
        `SELECT count(*) n FROM financial_instruments fi
           JOIN instrument_versions iv ON iv.id = fi.current_version_id
          WHERE fi.instrument_type <> iv.instrument_type`,
      ),
      duplicateLiveShareClassFigi: await count(
        `SELECT count(*) n FROM (
           SELECT ii.value FROM instrument_identifiers ii
            WHERE ii.scheme='share_class_figi'
              AND ii.supersedes_identifier_id IS NULL
              AND ii.id NOT IN (
                SELECT supersedes_identifier_id FROM instrument_identifiers
                 WHERE supersedes_identifier_id IS NOT NULL)
            GROUP BY ii.value
            HAVING count(DISTINCT ii.instrument_id) > 1) t`,
      ),
      duplicateLiveVenueFigi: await count(
        `SELECT count(*) n FROM (
           SELECT li.value FROM listing_identifiers li
            WHERE li.scheme='figi'
              AND li.id NOT IN (
                SELECT supersedes_identifier_id FROM listing_identifiers
                 WHERE supersedes_identifier_id IS NOT NULL)
            GROUP BY li.value
            HAVING count(DISTINCT li.listing_id) > 1) t`,
      ),
    },
    tickerCollisions: tickers.rows,
    providerConflicts: conflicts,
    unresolvedProviderRows: unresolved,
  };
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
writeFileSync(
  "bench/instrument-master-v12-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `seeded ${audit.instruments.length} instruments; conflicts=${conflicts.length} unresolved=${unresolved.length}`,
);
