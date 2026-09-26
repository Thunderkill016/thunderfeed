/* Instrument Master — DB apply/reconcile layer (pg-mem testable).
 *
 * Reconciliation order for an equity instrument:
 *   1. share_class_figi identifier → existing instrument (durable identity)
 *   2. verify issuer_entity_id matches the SEC-filer entity
 *   3. else create; canonical_key is a label, never the identity proof.
 *
 * Versions are written only when *semantic* fields differ
 * (instrumentVersionChanged / listingVersionChanged) — re-importing
 * unchanged provider data is a no-op.
 */
import type { Pool } from "pg";
import {
  instrumentVersionChanged,
  listingVersionChanged,
  venueVersionChanged,
  type InstrumentSeedPlan,
  type MicRow,
} from "../instruments";

type Q = Pick<Pool, "query">;

export type DerivationSubject =
  | { type: "instrument"; id: string }
  | { type: "instrument_version"; id: string }
  | { type: "listing"; id: string }
  | { type: "listing_version"; id: string }
  | { type: "venue"; id: string }
  | { type: "venue_version"; id: string }
  | { type: "instrument_identifier"; id: string }
  | { type: "listing_identifier"; id: string };

export type DerivationRole =
  "asserts" | "discovers" | "corroborates" | "venue_reference";

const SUBJECT_COL: Record<DerivationSubject["type"], string> = {
  instrument: "instrument_id",
  instrument_version: "instrument_version_id",
  listing: "listing_id",
  listing_version: "listing_version_id",
  venue: "venue_id",
  venue_version: "venue_version_id",
  instrument_identifier: "instrument_identifier_id",
  listing_identifier: "listing_identifier_id",
};

/** Append a typed subject↔observation derivation (idempotent). */
export async function recordDerivation(
  db: Q,
  subject: DerivationSubject,
  observationId: string,
  role: DerivationRole,
): Promise<void> {
  const col = SUBJECT_COL[subject.type];
  await db.query(
    `INSERT INTO master_derivations (subject_type, ${col}, observation_id, role)
     SELECT $1,$2,$3,$4
     WHERE NOT EXISTS (
       SELECT 1 FROM master_derivations
        WHERE ${col}=$2 AND observation_id=$3 AND role=$4)`,
    [subject.type, subject.id, observationId, role],
  );
}

export type ReconcileResult =
  | { kind: "existing"; instrumentId: string }
  | { kind: "created"; instrumentId: string }
  | { kind: "conflict"; reason: string };

/** Durable reconciliation: share_class_figi is the identity proof. */
export async function reconcileInstrument(
  db: Q,
  args: {
    canonicalKey: string;
    issuerEntityId: string;
    instrumentType: string;
    shareClassFigi: string | null;
  },
): Promise<ReconcileResult> {
  if (args.shareClassFigi) {
    const hit = await db.query(
      `SELECT i.id, i.issuer_entity_id FROM instrument_identifiers ii
         JOIN financial_instruments i ON i.id = ii.instrument_id
        WHERE ii.scheme='share_class_figi' AND ii.value=$1
          AND ii.id NOT IN (
            SELECT supersedes_identifier_id FROM instrument_identifiers
             WHERE supersedes_identifier_id IS NOT NULL)`,
      [args.shareClassFigi],
    );
    if (hit.rows.length) {
      const row = hit.rows[0];
      if (row.issuer_entity_id !== args.issuerEntityId)
        return {
          kind: "conflict",
          reason: `share_class_figi_issuer_mismatch:${args.shareClassFigi}`,
        };
      return { kind: "existing", instrumentId: row.id };
    }
  }
  const byKey = await db.query(
    `SELECT id FROM financial_instruments WHERE canonical_key=$1`,
    [args.canonicalKey],
  );
  if (byKey.rows.length)
    return { kind: "existing", instrumentId: byKey.rows[0].id };
  const ins = await db.query(
    `INSERT INTO financial_instruments
       (canonical_key, issuer_entity_id, instrument_type)
     VALUES ($1,$2,$3) RETURNING id`,
    [args.canonicalKey, args.issuerEntityId, args.instrumentType],
  );
  return { kind: "created", instrumentId: ins.rows[0].id };
}

export interface ApplyResult {
  instrumentId: string;
  instrumentVersionId: string | null; // null when state unchanged
  listingIds: string[];
}

export interface ApplySources {
  /** openfigi observation asserting the instrument version */
  figiObsId: string;
  /** SEC observation that discovered ticker↔issuer */
  secObsId: string;
  /** iso_10383 observation id per venue MIC (venue_reference) */
  venueObsIdByMic?: Record<string, string>;
}

export async function applyInstrumentPlan(
  db: Q,
  plan: InstrumentSeedPlan,
  issuerEntityId: string,
  sources: ApplySources,
): Promise<ApplyResult> {
  const shareClassFigi = plan.instrumentIdentifiers.find(
    (i) => i.scheme === "share_class_figi",
  )?.value;
  const rec = await reconcileInstrument(db, {
    canonicalKey: plan.instrumentKey,
    issuerEntityId,
    instrumentType: plan.instrumentType,
    shareClassFigi: shareClassFigi ?? null,
  });
  if (rec.kind === "conflict")
    throw new Error(`identity conflict: ${rec.reason}`);
  const instrumentId = rec.instrumentId;
  await recordDerivation(
    db,
    { type: "instrument", id: instrumentId },
    sources.secObsId,
    "discovers",
  );
  await recordDerivation(
    db,
    { type: "instrument", id: instrumentId },
    sources.figiObsId,
    "asserts",
  );

  // instrument version — only on semantic change
  const cur = await db.query(
    `SELECT iv.* FROM financial_instruments fi
       JOIN instrument_versions iv ON iv.id = fi.current_version_id
      WHERE fi.id=$1`,
    [instrumentId],
  );
  const nextAttrs = {
    name: plan.instrumentName,
    short_name: null,
    asset_class: "equity",
    instrument_type: plan.instrumentType,
    currency: plan.currency,
    share_class: plan.shareClass,
    cfi: plan.cfi,
    status: "active",
  };
  let versionId: string | null = null;
  const curRow = cur.rows[0] ?? null;
  if (!curRow || instrumentVersionChanged(curRow, nextAttrs)) {
    const no = curRow ? (curRow.version_no as number) + 1 : 1;
    const nv = await db.query(
      `INSERT INTO instrument_versions
         (instrument_id, version_no, name, asset_class, instrument_type,
          currency, share_class, cfi, observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        instrumentId,
        no,
        nextAttrs.name,
        nextAttrs.asset_class,
        nextAttrs.instrument_type,
        nextAttrs.currency,
        nextAttrs.share_class,
        nextAttrs.cfi,
        sources.figiObsId,
        curRow?.id ?? null,
      ],
    );
    versionId = nv.rows[0].id as string;
    await db.query(
      `UPDATE financial_instruments SET current_version_id=$1 WHERE id=$2`,
      [versionId, instrumentId],
    );
    await recordDerivation(
      db,
      { type: "instrument_version", id: versionId },
      sources.figiObsId,
      "asserts",
    );
    await recordDerivation(
      db,
      { type: "instrument_version", id: versionId },
      sources.secObsId,
      "corroborates",
    );
  }

  // identifiers — assertions, dedupe, provenance per row
  for (const idf of plan.instrumentIdentifiers) {
    const ins = await db.query(
      `INSERT INTO instrument_identifiers
         (instrument_id, scheme, value, scope, provider, observation_id, metadata)
       SELECT $1,$2,$3,$4,'openfigi',$5,$6::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM instrument_identifiers
          WHERE instrument_id=$1 AND scheme=$2 AND value=$3)
       RETURNING id`,
      [
        instrumentId,
        idf.scheme,
        idf.value,
        idf.scope,
        sources.figiObsId,
        JSON.stringify(idf.metadata ?? {}),
      ],
    );
    const identId = (ins.rows[0]?.id ??
      (
        await db.query(
          `SELECT id FROM instrument_identifiers
            WHERE instrument_id=$1 AND scheme=$2 AND value=$3`,
          [instrumentId, idf.scheme, idf.value],
        )
      ).rows[0].id) as string;
    await recordDerivation(
      db,
      { type: "instrument_identifier", id: identId },
      sources.figiObsId,
      "asserts",
    );
  }

  // listings — one per venue MIC that returned data
  const listingIds: string[] = [];
  for (const lp of plan.listings) {
    const venue = await db.query(`SELECT id FROM trading_venues WHERE mic=$1`, [
      lp.mic,
    ]);
    if (!venue.rows.length)
      throw new Error(`venue ${lp.mic} not imported — run import-mic first`);
    const venueId = venue.rows[0].id as string;
    const isoObsId = sources.venueObsIdByMic?.[lp.mic] ?? null;

    // reconcile by venue-level FIGI first (durable), then canonical_key
    let listingId: string | null = null;
    const byFigi = await db.query(
      `SELECT listing_id FROM listing_identifiers
        WHERE scheme='figi' AND value=$1
          AND id NOT IN (
            SELECT supersedes_identifier_id FROM listing_identifiers
             WHERE supersedes_identifier_id IS NOT NULL)`,
      [lp.figi],
    );
    if (byFigi.rows.length) listingId = byFigi.rows[0].listing_id;
    if (!listingId) {
      const byKey = await db.query(
        `SELECT id FROM instrument_listings WHERE canonical_key=$1`,
        [lp.listingKey],
      );
      if (byKey.rows.length) {
        listingId = byKey.rows[0].id;
      } else {
        const nl = await db.query(
          `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
           VALUES ($1,$2,$3) RETURNING id`,
          [lp.listingKey, instrumentId, venueId],
        );
        listingId = nl.rows[0].id as string;
        await recordDerivation(
          db,
          { type: "listing", id: listingId },
          sources.secObsId,
          "discovers",
        );
        await recordDerivation(
          db,
          { type: "listing", id: listingId },
          sources.figiObsId,
          "asserts",
        );
        if (isoObsId)
          await recordDerivation(
            db,
            { type: "listing", id: listingId },
            isoObsId,
            "venue_reference",
          );
      }
    }
    if (!listingId) throw new Error("listing identity failed to materialize");
    const lid = listingId;

    // listing version — semantic diff only; primary stays NULL unless a
    // provider actually asserts it (SEC/OpenFIGI don't)
    const lcur = await db.query(
      `SELECT lv.* FROM instrument_listings l
         JOIN listing_versions lv ON lv.id = l.current_version_id
        WHERE l.id=$1`,
      [lid],
    );
    const lNext = {
      ticker: lp.ticker,
      currency: lp.currency,
      status: "active",
      is_primary_listing: null, // unknown — never inferred
    };
    const lcRow = lcur.rows[0] ?? null;
    if (!lcRow || listingVersionChanged(lcRow, lNext)) {
      const no = lcRow ? (lcRow.version_no as number) + 1 : 1;
      const nlv = await db.query(
        `INSERT INTO listing_versions
           (listing_id, version_no, ticker, currency, status,
            is_primary_listing, observation_id, previous_version_id)
         VALUES ($1,$2,$3,$4,'active',NULL,$5,$6) RETURNING id`,
        [lid, no, lp.ticker, lp.currency, lp.obsId, lcRow?.id ?? null],
      );
      const lvid = nlv.rows[0].id;
      await db.query(
        `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
        [lvid, lid],
      );
      await recordDerivation(
        db,
        { type: "listing_version", id: lvid },
        lp.obsId,
        "asserts",
      );
      await recordDerivation(
        db,
        { type: "listing_version", id: lvid },
        sources.secObsId,
        "corroborates",
      );
      if (isoObsId)
        await recordDerivation(
          db,
          { type: "listing_version", id: lvid },
          isoObsId,
          "venue_reference",
        );
    }

    const lidInsert = await db.query(
      `INSERT INTO listing_identifiers
         (listing_id, scheme, value, provider, observation_id)
       SELECT $1,'figi',$2,'openfigi',$3
       WHERE NOT EXISTS (
         SELECT 1 FROM listing_identifiers
          WHERE listing_id=$1 AND scheme='figi' AND value=$2)
       RETURNING id`,
      [lid, lp.figi, lp.obsId],
    );
    const lidIdentId =
      lidInsert.rows[0]?.id ??
      (
        await db.query(
          `SELECT id FROM listing_identifiers
            WHERE listing_id=$1 AND scheme='figi' AND value=$2`,
          [lid, lp.figi],
        )
      ).rows[0].id;
    await recordDerivation(
      db,
      { type: "listing_identifier", id: lidIdentId },
      lp.obsId,
      "asserts",
    );
    listingIds.push(lid);
  }
  return { instrumentId, instrumentVersionId: versionId, listingIds };
}

/** Venue upsert driven by ISO 10383 row + version-diff — called by
 *  scripts/instruments/import-mic.mts. */
export async function upsertVenue(
  db: Q,
  v: MicRow,
  obsId: string,
): Promise<{
  mic: string;
  action: "created" | "version_appended" | "unchanged";
}> {
  const cur = await db.query(
    `SELECT tv.id AS venue_id, tvv.version_no,
            tvv.market_name, tvv.legal_entity_name, tvv.lei,
            tvv.country_code, tvv.city, tvv.operating_mic, tvv.mic_role,
            tvv.market_category, tvv.acronym, tvv.status
       FROM trading_venues tv
       LEFT JOIN trading_venue_versions tvv ON tvv.id = tv.current_version_id
      WHERE tv.mic = $1`,
    [v.mic],
  );
  const attrs = {
    market_name: v.marketName,
    legal_entity_name: v.legalEntityName,
    lei: v.lei,
    country_code: v.countryCode,
    city: v.city,
    operating_mic: v.operatingMic,
    mic_role: v.micRole,
    market_category: v.marketCategory,
    acronym: v.acronym,
    status: v.status,
    valid_from: v.validFrom,
    valid_to: v.validTo,
  };
  const row = cur.rows[0];
  if (row?.venue_id && !venueVersionChanged(row, attrs))
    return { mic: v.mic, action: "unchanged" };

  let venueId = row?.venue_id as string | undefined;
  if (!venueId) {
    const ins = await db.query(
      `INSERT INTO trading_venues (mic, status) VALUES ($1,$2) RETURNING id`,
      [v.mic, v.status],
    );
    venueId = ins.rows[0].id as string;
    await recordDerivation(
      db,
      { type: "venue", id: venueId },
      obsId,
      "asserts",
    );
  }
  const vid = venueId as string;
  const prevVersionId = row?.venue_id ? await currentVersionId(db, vid) : null;
  const nextNo = (row?.version_no ?? 0) + 1;
  const ver = await db.query(
    `INSERT INTO trading_venue_versions
       (venue_id, version_no, market_name, legal_entity_name, lei,
        country_code, city, operating_mic, mic_role, market_category,
        acronym, status, valid_from, valid_to, observation_id,
        previous_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      venueId,
      nextNo,
      attrs.market_name,
      attrs.legal_entity_name,
      attrs.lei,
      attrs.country_code,
      attrs.city,
      attrs.operating_mic,
      attrs.mic_role,
      attrs.market_category,
      attrs.acronym,
      attrs.status,
      attrs.valid_from,
      attrs.valid_to,
      obsId,
      prevVersionId,
    ],
  );
  await db.query(
    `UPDATE trading_venues SET current_version_id=$1, status=$2 WHERE id=$3`,
    [ver.rows[0].id, v.status, venueId],
  );
  await recordDerivation(
    db,
    { type: "venue_version", id: ver.rows[0].id },
    obsId,
    "asserts",
  );
  return {
    mic: v.mic,
    action: row?.venue_id ? "version_appended" : "created",
  };
}

async function currentVersionId(
  db: Q,
  venueId: string,
): Promise<string | null> {
  const r = await db.query(
    `SELECT current_version_id FROM trading_venues WHERE id=$1`,
    [venueId],
  );
  return (r.rows[0]?.current_version_id as string) ?? null;
}
