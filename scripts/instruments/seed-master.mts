/* Instrument Master seeder — derives instruments/listings/identifiers
 * exclusively from stored reference_observations (SEC + OpenFIGI + ISO MIC).
 *
 *   npx tsx scripts/instruments/seed-master.mts
 *
 * Conservative promotion: provider disagreement → 'provider_conflict' audit
 * entry, nothing is promoted. Missing provider data → 'unresolved'. Writes
 * bench/instrument-master-audit.json (Phase 21 artifact).
 */
import { writeFileSync } from "node:fs";
import {
  deriveSeed,
  parseFigiMappingResponse,
  SEC_EXCHANGE_MIC_CANDIDATES,
  type FigiResult,
  type InstrumentSeedPlan,
} from "../../lib/instruments.ts";
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

async function applyPlan(
  c: Client,
  plan: InstrumentSeedPlan,
  issuerId: string,
  figiObsId: string,
  secObsId: string,
): Promise<{ instrumentId: string; listingId: string }> {
  // instrument — stable identity by canonical_key
  let ins = await c.query(
    `SELECT id, current_version_id FROM financial_instruments WHERE canonical_key=$1`,
    [plan.instrumentKey],
  );
  let instrumentId: string;
  let prevVersion: string | null = null;
  let versionNo = 1;
  if (ins.rows.length) {
    instrumentId = ins.rows[0].id;
    prevVersion = ins.rows[0].current_version_id;
    if (prevVersion) {
      const v = await c.query(
        `SELECT version_no, name FROM instrument_versions WHERE id=$1`,
        [prevVersion],
      );
      if (v.rows[0].name === plan.instrumentName)
        versionNo = 0; // unchanged → skip new version
      else versionNo = (v.rows[0].version_no as number) + 1;
    }
  } else {
    const ni = await c.query(
      `INSERT INTO financial_instruments (canonical_key, issuer_entity_id, instrument_type)
       VALUES ($1,$2,$3) RETURNING id`,
      [plan.instrumentKey, issuerId, plan.instrumentType],
    );
    instrumentId = ni.rows[0].id;
  }
  if (versionNo > 0) {
    const nv = await c.query(
      `INSERT INTO instrument_versions
         (instrument_id, version_no, name, asset_class, instrument_type,
          currency, share_class, observation_id, previous_version_id)
       VALUES ($1,$2,$3,'equity',$4,$5,$6,$7,$8) RETURNING id`,
      [
        instrumentId,
        versionNo,
        plan.instrumentName,
        plan.instrumentType,
        plan.currency,
        plan.shareClass,
        figiObsId,
        prevVersion,
      ],
    );
    await c.query(
      `UPDATE financial_instruments SET current_version_id=$1 WHERE id=$2`,
      [nv.rows[0].id, instrumentId],
    );
  }

  // identifiers — append-only assertions, dedupe on (id, scheme, value)
  for (const idf of plan.instrumentIdentifiers) {
    await c.query(
      `INSERT INTO instrument_identifiers
         (instrument_id, scheme, value, scope, provider, observation_id)
       SELECT $1,$2,$3,$4,'openfigi',$5
       WHERE NOT EXISTS (
         SELECT 1 FROM instrument_identifiers
          WHERE instrument_id=$1 AND scheme=$2 AND value=$3)`,
      [instrumentId, idf.scheme, idf.value, idf.scope, figiObsId],
    );
  }

  // one listing per venue MIC that returned data
  const listingIds: string[] = [];
  for (const lp of plan.listings) {
    const venue = await c.query(`SELECT id FROM trading_venues WHERE mic=$1`, [
      lp.mic,
    ]);
    if (!venue.rows.length)
      throw new Error(`venue ${lp.mic} not imported — run import-mic first`);
    const venueId = venue.rows[0].id as string;

    let l = await c.query(
      `SELECT id, current_version_id FROM instrument_listings WHERE canonical_key=$1`,
      [lp.listingKey],
    );
    let listingId: string;
    let lPrev: string | null = null;
    let lNo = 1;
    if (l.rows.length) {
      listingId = l.rows[0].id;
      lPrev = l.rows[0].current_version_id;
      const lv = await c.query(
        `SELECT version_no, ticker, currency FROM listing_versions WHERE id=$1`,
        [lPrev],
      );
      if (lv.rows[0]?.ticker === lp.ticker) lNo = 0;
      else lNo = (lv.rows[0].version_no as number) + 1;
    } else {
      const nl = await c.query(
        `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [lp.listingKey, instrumentId, venueId],
      );
      listingId = nl.rows[0].id;
    }
    if (lNo > 0) {
      const nlv = await c.query(
        `INSERT INTO listing_versions
           (listing_id, version_no, ticker, currency, status, is_primary_listing,
            observation_id, previous_version_id)
         VALUES ($1,$2,$3,$4,'active',true,$5,$6) RETURNING id`,
        [listingId, lNo, lp.ticker, lp.currency, lp.obsId, lPrev],
      );
      await c.query(
        `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
        [nlv.rows[0].id, listingId],
      );
    }
    await c.query(
      `INSERT INTO listing_identifiers
         (listing_id, scheme, value, provider, observation_id)
       SELECT $1,'figi',$2,'openfigi',$3
       WHERE NOT EXISTS (
         SELECT 1 FROM listing_identifiers
          WHERE listing_id=$1 AND scheme='figi' AND value=$2)`,
      [listingId, lp.figi, lp.obsId],
    );
    listingIds.push(listingId);
  }
  void secObsId;
  return { instrumentId, listingIds };
}

const c = connectDb();
await c.connect();
const conflicts: { issuer: string; ticker: string; reason: string }[] = [];
const unresolved: { issuer: string; ticker: string; reason: string }[] = [];
try {
  // seed universe: every entity carrying a cik identifier
  const issuers = await c.query(
    `SELECT e.id, e.canonical_key, ei.value AS cik
       FROM entities e JOIN entity_identifiers ei ON ei.entity_id=e.id
      WHERE ei.scheme='cik' AND e.entity_type='company' AND e.status='active'
      ORDER BY e.canonical_key`,
  );
  await c.query("BEGIN");
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
      if (outcome.kind === "plan") {
        const { instrumentId, listingIds } = await applyPlan(
          c,
          outcome.plan,
          iss.id,
          outcome.plan.listings[0].obsId,
          s.id,
        );
        audit.instruments.push({
          issuerEntity: iss.canonical_key,
          instrument: {
            id: instrumentId,
            canonicalKey: outcome.plan.instrumentKey,
            name: outcome.plan.instrumentName,
            type: outcome.plan.instrumentType,
            shareClass: outcome.plan.shareClass,
            currency: outcome.plan.currency,
          },
          listings: outcome.plan.listings.map((l, i) => ({
            id: listingIds[i],
            canonicalKey: l.listingKey,
            mic: l.mic,
            ticker: l.ticker,
            currency: l.currency,
            figi: l.figi,
          })),
          identifiers: {
            instrument: outcome.plan.instrumentIdentifiers,
          },
          sources: [
            "sec_edgar:company_tickers_exchange",
            "openfigi:mapping_v3",
            "iso_10383:mic_list",
          ],
          observedAt: new Date().toISOString(),
        });
      }
    }
  }
  // Phase 21 metrics — computed inside the same connection, post-commit.
  const count = async (q: string) => Number((await c.query(q)).rows[0].n);
  const tickers = await c.query(
    `SELECT ticker, count(DISTINCT l.venue_id) AS venues
       FROM listing_versions lv
       JOIN instrument_listings l ON l.current_version_id = lv.id
      GROUP BY ticker HAVING count(DISTINCT l.venue_id) > 1`,
  );
  audit.metrics = {
    issuers: issuers.rows.length,
    instruments: await count(`SELECT count(*) n FROM financial_instruments`),
    listings: await count(`SELECT count(*) n FROM instrument_listings`),
    venues: await count(`SELECT count(*) n FROM trading_venues`),
    instrumentIdentifiers: await count(
      `SELECT count(*) n FROM instrument_identifiers`,
    ),
    listingIdentifiers: await count(
      `SELECT count(*) n FROM listing_identifiers`,
    ),
    referenceObservations: await count(
      `SELECT count(*) n FROM reference_observations`,
    ),
    instrumentsWithFigi: await count(
      `SELECT count(DISTINCT instrument_id) n FROM instrument_identifiers
        WHERE scheme IN ('share_class_figi','composite_figi')`,
    ),
    listingsWithMic: await count(
      `SELECT count(DISTINCT l.id) n FROM instrument_listings l
        JOIN trading_venues v ON v.id = l.venue_id WHERE v.mic IS NOT NULL`,
    ),
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
  "bench/instrument-master-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `seeded ${audit.instruments.length} instruments; conflicts=${conflicts.length} unresolved=${unresolved.length}`,
);
