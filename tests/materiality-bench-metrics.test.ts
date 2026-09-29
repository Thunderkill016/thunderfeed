/* R7.1d.1c — benchmark-metric integrity: the evaluation path itself must
 * count typed-target mismatches as FP+FN so a gold copied from predictions
 * can never be silently validated by bare-key agreement. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setIoU, setPR } from "../scripts/materiality/metrics";

describe("bench metric integrity", () => {
  it("typed-target mismatch counts as FP+FN, never a bare-key match", () => {
    // prediction says country_exposure:us; reviewed gold says sector:banking
    const { precision, recall, tp } = setPR(
      ["country_exposure:us"],
      ["sector:banking"],
    );
    assert.equal(tp, 0);
    assert.equal(precision, 0);
    assert.equal(recall, 0);
  });

  it("identical typed keys score perfect", () => {
    const { precision, recall } = setPR(
      ["country_exposure:vn", "entity:fpt"],
      ["entity:fpt", "country_exposure:vn"],
    );
    assert.equal(precision, 1);
    assert.equal(recall, 1);
  });

  it("empty-vs-empty yields null, not fake perfection", () => {
    const r = setPR([], []);
    assert.equal(r.precision, null);
    assert.equal(r.recall, null);
    assert.equal(setIoU([], []), null);
  });

  it("partial overlap reports honest fractions", () => {
    const { precision, recall } = setPR(["a", "b"], ["b", "c"]);
    assert.equal(precision, 0.5);
    assert.equal(recall, 0.5);
    assert.equal(setIoU(["a", "b"], ["b", "c"]), 1 / 3);
  });
});
