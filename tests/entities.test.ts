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

import { canonicalEntity, entityKind, gazetteerEntries } from "../lib/entities";

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

test("canonical: every gazetteer slug maps to a canonical identity", () => {
  /* the drift guard that actually matters — a slug without a canonical
   * key silently drops out of the identity layer (junction entity_id
   * stays null); iterate the real gazetteer, not a copied list */
  for (const def of gazetteerEntries()) {
    const canon = canonicalEntity(def.slug);
    assert.ok(canon, `${def.slug} has no canonical entity`);
    assert.ok(canon.key.includes(":"), `${def.slug} key must be type-prefixed`);
    assert.ok(entityKind(def.slug), `${def.slug} lost its kind`);
  }
});
