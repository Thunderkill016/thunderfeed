/**
 * Feed-registry invariants. Source diversity only pays off if every
 * registered outlet resolves to ownership/typology metadata — otherwise the
 * framing layer cannot compare who is reporting. Network liveness is
 * intentionally NOT asserted here (endpoints rot); these tests pin the
 * static contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { feeds } from "../lib/feeds";
import { mediaInfoFor } from "../lib/mediaData";

test("feed ids and urls are unique", () => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const f of feeds) {
    assert.ok(!ids.has(f.id), `duplicate feed id: ${f.id}`);
    assert.ok(!urls.has(f.url), `duplicate feed url: ${f.url} (${f.id})`);
    ids.add(f.id);
    urls.add(f.url);
  }
});

test("every feed is a well-formed https url with topic/language", () => {
  for (const f of feeds) {
    const u = new URL(f.url);
    assert.equal(u.protocol, "https:", `${f.id} must use https`);
    assert.ok(f.topic, `${f.id} missing topic`);
    assert.ok(
      f.language === "vi" || f.language === "en",
      `${f.id} unexpected language ${f.language}`,
    );
  }
});

test("every registered feed resolves to media metadata (ownership)", () => {
  const missing = feeds
    .filter((f) => !mediaInfoFor(f.name, f.url))
    .map((f) => `${f.id} (${f.name} <${f.url}>)`);
  assert.deepEqual(
    missing,
    [],
    `feeds without ownership metadata: ${missing.join(", ")}`,
  );
});

test("vietnamese-language feeds carry region=vietnam or explicit intl service", () => {
  // vi feeds are either domestic outlets (region=vietnam) or international
  // broadcasters in Vietnamese (region=world, e.g. BBC Việt, RFI Tiếng Việt).
  for (const f of feeds.filter((f) => f.language === "vi")) {
    assert.ok(
      f.region === "vietnam" || f.region === "world",
      `${f.id} vi feed has unexpected region ${f.region}`,
    );
  }
});
