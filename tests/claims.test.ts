import assert from "node:assert/strict";
import test from "node:test";
import { validateClaims } from "../lib/claims";

const SOURCES = new Set(["VnExpress", "Tuổi Trẻ", "BBC World News"]);
const NUMBERS = new Set([10, 20, 2026]);

const GROUNDED = {
  consensus: [
    {
      point: "Hai bên đã ký thỏa thuận hợp tác chiến lược",
      sources: ["VnExpress", "Tuổi Trẻ"],
    },
  ],
  disputes: [
    {
      topic: "Con số thiệt hại",
      positions: [
        { source: "VnExpress", claim: "Thiệt hại 10 người" },
        { source: "BBC World News", claim: "Death toll at 20" },
      ],
    },
  ],
};

test("validateClaims accepts a grounded matrix", () => {
  const out = validateClaims(GROUNDED, SOURCES, NUMBERS);
  assert.ok(out);
  assert.equal(out.consensus.length, 1);
  assert.equal(out.disputes.length, 1);
  assert.equal(out.disputes[0].positions.length, 2);
});

test("validateClaims rejects a source not in the cluster", () => {
  const raw = {
    consensus: [
      {
        point: "Nguồn bịa không tồn tại trong cụm",
        sources: ["VnExpress", "Reuters Fiction"],
      },
    ],
    disputes: [],
  };
  assert.equal(validateClaims(raw, SOURCES, NUMBERS), null);
});

test("validateClaims rejects fabricated numbers", () => {
  const raw = {
    consensus: [
      {
        point: "Vụ việc khiến 500 người thương vong",
        sources: ["VnExpress", "Tuổi Trẻ"],
      },
    ],
    disputes: [],
  };
  assert.equal(validateClaims(raw, SOURCES, NUMBERS), null);
});

test("validateClaims rejects single-source consensus and one-sided disputes", () => {
  const raw = {
    consensus: [{ point: "Chỉ một nguồn nói", sources: ["VnExpress"] }],
    disputes: [
      {
        topic: "Bất đồng một phía",
        positions: [{ source: "VnExpress", claim: "Không ai phản biện" }],
      },
    ],
  };
  assert.equal(validateClaims(raw, SOURCES, NUMBERS), null);
});

test("validateClaims rejects malformed payloads", () => {
  assert.equal(validateClaims(null, SOURCES, NUMBERS), null);
  assert.equal(validateClaims("text", SOURCES, NUMBERS), null);
  assert.equal(validateClaims({ consensus: {} }, SOURCES, NUMBERS), null);
  assert.equal(
    validateClaims({ consensus: [], disputes: [] }, SOURCES, NUMBERS),
    null,
  );
});
