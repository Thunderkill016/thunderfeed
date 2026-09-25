/**
 * entityLabel — canonical slugs must never leak raw to the UI. Overrides
 * cover acronyms and vi short names; the gazetteer fallback prefers the
 * diacritic-bearing alias, title-cased.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { entityLabel } from "../lib/entities";

test("entityLabel: acronym overrides", () => {
  assert.equal(entityLabel("federal_reserve"), "FED");
  assert.equal(entityLabel("nhnn"), "NHNN");
  assert.equal(entityLabel("ai"), "AI");
});

test("entityLabel: vi short-name overrides beat english first alias", () => {
  assert.equal(entityLabel("germany"), "Đức");
  assert.equal(entityLabel("france"), "Pháp");
  assert.equal(entityLabel("us"), "Mỹ");
  assert.equal(entityLabel("russia"), "Nga");
});

test("entityLabel: gazetteer fallback uses the vi alias, title-cased", () => {
  assert.equal(entityLabel("hanoi"), "Hà Nội");
  assert.equal(entityLabel("china"), "Trung Quốc");
  assert.equal(entityLabel("xijinping"), "Tập Cận Bình");
});

test("entityLabel: entity_ prefix and unknown slugs degrade cleanly", () => {
  assert.equal(entityLabel("entity_vietnam"), "Việt Nam");
  assert.equal(entityLabel("some_thing_new"), "Some Thing New");
});

import { entityKind } from "../lib/entities";

test("entityKind: gazetteer slugs resolve to the curated kind", () => {
  // countries & localities default to place
  assert.equal(entityKind("us"), "place");
  assert.equal(entityKind("vietnam"), "place");
  assert.equal(entityKind("hanoi"), "place");
  assert.equal(entityKind("southchinasea"), "place");
  // institutions & companies
  assert.equal(entityKind("nato"), "org");
  assert.equal(entityKind("federal_reserve"), "org");
  assert.equal(entityKind("openai"), "org");
  // people
  assert.equal(entityKind("trump"), "person");
  assert.equal(entityKind("xijinping"), "person");
  // abstract story anchors
  assert.equal(entityKind("oil"), "topic");
  assert.equal(entityKind("ai"), "topic");
});

test("entityKind: non-gazetteer slugs return null, entity_ prefix unwraps", () => {
  assert.equal(entityKind("not_a_thing"), null);
  assert.equal(entityKind("entity_us"), "place");
});

test("entityKind: every curated non-place kind still maps a live gazetteer slug", () => {
  /* drift guard — if a slug is renamed or removed from the gazetteer its
   * curated kind silently degrades to null; this list must stay in sync
   * with KIND_BY_SLUG (kept explicit so removals fail loudly here) */
  const nonPlace = [
    "nato",
    "un",
    "asean",
    "aseancup",
    "asiad",
    "unga",
    "brics",
    "g20",
    "federal_reserve",
    "nhnn",
    "ecb",
    "boj",
    "opec",
    "imf",
    "worldbank",
    "wto",
    "who",
    "openai",
    "anthropic",
    "spacex",
    "tesla",
    "meta",
    "google",
    "apple",
    "microsoft",
    "nvidia",
    "bytedance",
    "vinfast",
    "viettel",
    "samsung",
    "intel",
    "boeing",
    "airbus",
    "trump",
    "putin",
    "zelensky",
    "xijinping",
    "hunsen",
    "kimsangsik",
    "kimjongun",
    "netanyahu",
    "modi",
    "milei",
    "lam",
    "biden",
    "macron",
    "starmer",
    "vonderleyen",
    "pm",
    "pipeline",
    "oil",
    "drone",
    "ai",
    "semiconductor",
    "trade_surplus",
    "song_hong",
    "nine_eleven",
  ];
  for (const slug of nonPlace) {
    assert.notEqual(entityKind(slug), null, `${slug} lost its gazetteer entry`);
    assert.notEqual(entityKind(slug), "place", `${slug} must not be a place`);
  }
});
