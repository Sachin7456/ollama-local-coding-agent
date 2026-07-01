// Auto-tests: Ctrl+R reverse-search reducer (pure). History is newest-first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSearch, matches, applyKey, renderSearch } from "../src/ui/reverseSearch.ts";
import { makeTheme } from "../src/ui/theme.ts";
import type { Key } from "../src/ui/io.ts";

const key = (o: Partial<Key> = {}): Key => ({ sequence: "", ctrl: false, meta: false, shift: false, ...o });
const HIST = ["git status", "grep foo", "git commit"]; // newest-first

test("matches: substring filter; empty query → none", () => {
  assert.deepEqual(matches(HIST, "git"), ["git status", "git commit"]);
  assert.deepEqual(matches(HIST, ""), []);
});

test("applyKey: type filters, Ctrl+R cycles, Enter accepts, Esc cancels", () => {
  let s = makeSearch();
  s = applyKey(s, key({ sequence: "g" }), HIST).state;
  s = applyKey(s, key({ sequence: "i" }), HIST).state;
  s = applyKey(s, key({ sequence: "t" }), HIST).state; // "git"
  assert.equal(s.query, "git");
  const cyc = applyKey(s, key({ name: "r", ctrl: true }), HIST);
  assert.equal(cyc.state.index, 1);
  assert.equal(applyKey(cyc.state, key({ name: "return" }), HIST).accept, "git commit");
  assert.equal(applyKey(s, key({ name: "escape" }), HIST).cancel, true);
});

test("renderSearch shows the query + match; themed adds ANSI", () => {
  const s = { query: "git", index: 0 };
  assert.ok(renderSearch(s, HIST, makeTheme(false)).includes("git status"));
  assert.ok(renderSearch(s, HIST, makeTheme(true)).includes("\x1b["));
});
