/**
 * Canonical change grouping — the rail and the Telegram digest share
 * lib/changes.ts so coverage ("another source confirmed") collapses per
 * event instead of spamming one card/line per source. Regression for the
 * digest flood where one hot event emitted 8 identical cards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupChanges,
  groupChangesByEvent,
  materialityName,
  changeSummaryText,
  type ChangeLike,
} from "../lib/changes";
import { formatAlertMessages } from "../lib/telegram";

const ch = (over: Partial<ChangeLike>): ChangeLike => ({
  eventId: "e1",
  eventTitle: "Sự kiện A",
  type: "claim_updated",
  materiality: "medium",
  summary: "519 triệu USD",
  detectedAt: "2026-09-25T02:00:00Z",
  ...over,
});

test("dedupChanges: identical (event,type,summary) rows collapse", () => {
  const rows = [ch({}), ch({}), ch({ summary: "khác" })];
  assert.equal(dedupChanges(rows).length, 2);
});

test("groupChangesByEvent: coverage rows collapse to source list", () => {
  const rows = [
    ch({
      type: "new_independent_evidence",
      summary: "Nguồn độc lập mới xác nhận: VTV",
    }),
    ch({
      type: "new_independent_evidence",
      summary: "Nguồn độc lập mới xác nhận: VnExpress",
    }),
    ch({
      type: "new_independent_evidence",
      summary: "Nguồn độc lập mới xác nhận: VTV",
    }),
    ch({ type: "claim_updated", materiality: "high" }),
  ];
  const groups = groupChangesByEvent(rows);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(g.coverageSources.sort(), ["VTV", "VnExpress"]);
  assert.equal(g.substantive.length, 1);
  assert.equal(g.rank, 0, "high materiality wins");
  assert.equal(materialityName(g.rank), "high");
});

test("groupChangesByEvent: orders by materiality then recency", () => {
  const rows = [
    ch({
      eventId: "e-low",
      eventTitle: "Low",
      materiality: "low",
      detectedAt: "2026-09-25T03:00:00Z",
    }),
    ch({
      eventId: "e-high",
      eventTitle: "High",
      materiality: "high",
      detectedAt: "2026-09-25T01:00:00Z",
    }),
    ch({
      eventId: "e-med",
      eventTitle: "Med",
      materiality: "medium",
      detectedAt: "2026-09-25T02:00:00Z",
    }),
  ];
  const order = groupChangesByEvent(rows).map((g) => g.eventId);
  assert.deepEqual(order, ["e-high", "e-med", "e-low"]);
});

test("changeSummaryText: strips duplicate label prefix", () => {
  const c = ch({ summary: "Dữ kiện mới: 519 triệu USD" });
  assert.equal(changeSummaryText(c, "Dữ kiện mới"), "519 triệu USD");
  assert.equal(changeSummaryText(c, "Cập nhật"), "Dữ kiện mới: 519 triệu USD");
});

test("formatAlertMessages: event_created marks the header, no echo bullet", () => {
  const rows = [0, 1, 2, 3].map((i) =>
    ch({
      eventId: `ev${i}`,
      eventTitle: `Sự kiện ${i}`,
      type: "event_created",
      materiality: "high",
      summary: `Sự kiện ${i}`,
    }),
  );
  const [msg] = formatAlertMessages(rows);
  assert.match(msg, /▸ Sự kiện mới — Sự kiện 0/);
  // the bullet that restates the title must not exist
  assert.ok(!/• Sự kiện mới: Sự kiện 0/.test(msg));
});

test("formatAlertMessages: caps substantive lines per event, disputes first", () => {
  const rows = [
    ch({ eventId: "e1", type: "new_claim", summary: "claim 1" }),
    ch({ eventId: "e1", type: "new_claim", summary: "claim 2" }),
    ch({ eventId: "e1", type: "new_claim", summary: "claim 3" }),
    ch({ eventId: "e1", type: "new_claim", summary: "claim 4" }),
    ch({ eventId: "e1", type: "claim_disputed", summary: "con số mâu thuẫn" }),
    // a second event so the digest (not single-alert) path renders
    ch({ eventId: "e2", eventTitle: "Sự kiện B", summary: "x" }),
  ];
  const [msg] = formatAlertMessages(rows);
  // disputed outranks the four new_claim lines
  assert.ok(msg.indexOf("Mâu thuẫn: con số mâu thuẫn") < msg.indexOf("claim 1"));
  // cap leaves one overflow counter, not a 5th bullet
  assert.match(msg, /…2 dữ kiện khác trên app/);
});
