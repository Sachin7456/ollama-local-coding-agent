// Auto-tests: paste collapse/expand store (pure).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PasteStore } from "../src/ui/paste.ts";

test("small paste is inserted inline (no placeholder)", () => {
  const s = new PasteStore();
  const r = s.add("just a short line");
  assert.equal(r.insert, "just a short line");
  assert.equal(r.entry, undefined);
});

test("large paste collapses to a placeholder and expands back on submit", () => {
  const s = new PasteStore();
  const big = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
  const r = s.add(big);
  assert.match(r.insert, /^\[Pasted text #1 \+8 lines\]$/);
  assert.equal(s.expand(r.insert), big);
  assert.equal(s.expand(`before ${r.insert} after`), `before ${big} after`);
  assert.equal(s.hasRefs(r.insert), true);
});

test("long single-line paste collapses by char count; unknown ref left as-is", () => {
  const s = new PasteStore();
  const r = s.add("x".repeat(300));
  assert.match(r.insert, /\[Pasted text #1 \+1 lines\]/);
  assert.equal(s.expand("[Pasted text #999 +2 lines]"), "[Pasted text #999 +2 lines]"); // no such id → unchanged
});

test("image paste gets an [Image #N] placeholder + retrievable payload", () => {
  const s = new PasteStore();
  const r = s.addImage("data:image/png;base64,AAAA");
  assert.match(r.insert, /^\[Image #1\]$/);
  assert.equal(s.get(1)?.kind, "image");
});
