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
