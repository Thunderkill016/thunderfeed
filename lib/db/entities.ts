/**
 * Canonical entity extraction moved to lib/entities.ts — one ontology
 * for clustering, the resolver, and benchmarks. Kept as a re-export so
 * existing imports keep working.
 */
export { extractEntities, entitySignature } from "../entities";
