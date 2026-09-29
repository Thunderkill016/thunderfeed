/* Tiny pure set-metrics shared between bench-events.mts and its unit test.
 * Everything is string-keyed ("type:key", channel names, claim ids) so the
 * same code path evaluates predictions AND would catch a circular gold. */

export function setIntersection<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => b.has(x));
}

/** precision/recall of a predicted set against a gold set. A typed-key
 * mismatch (pred "country_exposure:us" vs gold "sector:banking") counts
 * as FP+FN — bare-key agreement never leaks through. */
export function setPR(
  pred: string[],
  gold: string[],
): {
  precision: number | null;
  recall: number | null;
  tp: number;
} {
  const tp = setIntersection(new Set(pred), new Set(gold)).length;
  return {
    tp,
    precision: pred.length ? tp / pred.length : gold.length ? 0 : null,
    recall: gold.length ? tp / gold.length : pred.length ? 0 : null,
  };
}

/** Jaccard over string sets; null when both sides are empty. */
export function setIoU(pred: string[], gold: string[]): number | null {
  const a = new Set(pred),
    b = new Set(gold);
  if (!a.size && !b.size) return null;
  const inter = setIntersection(a, b).length;
  return inter / (a.size + b.size - inter);
}
