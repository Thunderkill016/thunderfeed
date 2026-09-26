/**
 * Gazetteer-projection reconciliation — the shared diff/apply behind
 * scripts/reconcile-evidence-entities.mts. Pure planning so the rules
 * are unit-testable; apply touches ONLY method='gazetteer' rows (the
 * derived projection), never structured provenance or EvidenceVersion.
 */
import type { PoolClient } from "pg";
import type { EvidenceEntityRow } from "./writer";

export interface StoredEvidenceRow {
  id: string;
  entity_id: string;
  canonical_key: string;
  mention_role: string;
  in_title: boolean;
  method: string;
  matched_slug: string | null;
}

export interface ReconcilePlan {
  stale: StoredEvidenceRow[];
  missing: EvidenceEntityRow[];
  kept: StoredEvidenceRow[];
  /** kept rows whose matched_slug/in_title drifted from the current
   *  matcher output — rebuilt so every row explains surface→slug→entity */
  refresh: { row: StoredEvidenceRow; slug: string | null; title: boolean }[];
  unchanged: number;
}

const keyOf = (id: string, role: string) => `${id} ${role}`;

export function planEvidenceReconciliation(
  stored: StoredEvidenceRow[],
  expected: EvidenceEntityRow[],
): ReconcilePlan {
  const storedGaz = stored.filter((r) => r.method === "gazetteer");
  const expectedGaz = expected.filter((r) => r.method === "gazetteer");
  const expectedKeys = new Map(
    expectedGaz.map((r) => [keyOf(r.id, r.role), r]),
  );
  const storedKeys = new Map(
    storedGaz.map((r) => [keyOf(r.entity_id, r.mention_role), r]),
  );

  const stale = storedGaz.filter(
    (r) => !expectedKeys.has(keyOf(r.entity_id, r.mention_role)),
  );
  const missing = expectedGaz.filter(
    (r) => !storedKeys.has(keyOf(r.id, r.role)),
  );
  const kept = storedGaz.filter((r) =>
    expectedKeys.has(keyOf(r.entity_id, r.mention_role)),
  );
  const refresh = kept
    .map((row) => {
      const exp = expectedKeys.get(keyOf(row.entity_id, row.mention_role))!;
      return { row, slug: exp.slug ?? null, title: exp.title };
    })
    .filter(
      ({ row, slug, title }) =>
        row.matched_slug !== slug || row.in_title !== title,
    );
  return { stale, missing, kept, refresh, unchanged: kept.length };
}

/** Apply a plan inside the caller's transaction. Gazetteer rows only —
 *  structured issuer provenance is unreachable from here. */
export async function applyEvidencePlan(
  client: PoolClient,
  versionId: string,
  plan: ReconcilePlan,
): Promise<void> {
  for (const r of plan.stale) {
    await client.query(
      `DELETE FROM evidence_entities WHERE id = $1 AND method = 'gazetteer'`,
      [r.id],
    );
  }
  for (const r of plan.missing) {
    await client.query(
      `INSERT INTO evidence_entities
         (evidence_version_id, entity_id, mention_role, in_title, method, matched_slug)
       VALUES ($1, $2, $3, $4, 'gazetteer', $5)
       ON CONFLICT DO NOTHING`,
      [versionId, r.id, r.role, r.title, r.slug ?? null],
    );
  }
  for (const { row, slug, title } of plan.refresh) {
    await client.query(
      `UPDATE evidence_entities SET matched_slug = $2, in_title = $3
       WHERE id = $1 AND method = 'gazetteer'`,
      [row.id, slug, title],
    );
  }
}
