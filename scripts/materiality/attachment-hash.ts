/* R7.1d.3a.1 — semantic corpusHash for the attachment corpus.
 *
 * Pins every input the labels/metrics consume: event identity + version
 * + title, claim identity + current version + materiality assessment,
 * standing-evidence (documentId, evidenceVersionId) pairs, ACTIVE event
 * fanout per doc, event-level evidence edges (incl. detached flag), and
 * resolver merge paths. generatedAt excluded — same semantic input →
 * same hash. Every array is sorted inside → shuffle-stable.
 *
 * Shared by dump-attachments.mts and the hash regression tests so the
 * canonicalization CANNOT drift between dump and verification. */
import { createHash } from "node:crypto";

interface CorpusEventLike {
  eventId: string;
  eventVersionId: string | null;
  title: string | null;
  mergePaths: Record<string, number>;
  eventEvidence: {
    documentId: string;
    evidenceVersionId: string;
    detached: boolean;
    activeEvents: string[];
  }[];
  claims: {
    claimId: string;
    currentClaimVersionId: string | null;
    materialityAssessmentId: string | null;
    standingEvidence: {
      documentId: string;
      evidenceVersionId: string;
      activeEvents: string[];
    }[];
  }[];
}

export function attachmentCorpusHash(events: CorpusEventLike[]): string {
  const canonical = events
    .map((e) => ({
      eventId: e.eventId,
      eventVersionId: e.eventVersionId,
      title: e.title,
      mergePaths: Object.entries(e.mergePaths)
        .map(([path, n]) => [path, n] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
      eventEvidence: e.eventEvidence
        .map((d) => ({
          documentId: d.documentId,
          evidenceVersionId: d.evidenceVersionId,
          detached: d.detached,
          activeEvents: [...d.activeEvents].sort(),
        }))
        .sort((a, b) => a.evidenceVersionId.localeCompare(b.evidenceVersionId)),
      claims: e.claims
        .map((c) => ({
          claimId: c.claimId,
          currentClaimVersionId: c.currentClaimVersionId,
          materialityAssessmentId: c.materialityAssessmentId,
          standing: c.standingEvidence
            .map((s) => ({
              documentId: s.documentId,
              evidenceVersionId: s.evidenceVersionId,
              activeEvents: [...s.activeEvents].sort(),
            }))
            .sort((a, b) =>
              a.evidenceVersionId.localeCompare(b.evidenceVersionId),
            ),
        }))
        .sort((a, b) => a.claimId.localeCompare(b.claimId)),
    }))
    .sort((a, b) => a.eventId.localeCompare(b.eventId));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}
