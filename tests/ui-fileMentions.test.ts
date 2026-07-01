// Auto-tests: @-mention fuzzy matching + token find/replace (pure parts). No filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, fuzzyFilter, mentionQuery, applyMention } from "../src/ui/fileMentions.ts";

test("fuzzyScore: subsequence match vs non-match", () => {
  assert.notEqual(fuzzyScore("ac", "abc"), null); // a..c is a subsequence
  assert.equal(fuzzyScore("ba", "abc"), null); // 'a' after 'b' not possible
  assert.ok((fuzzyScore("abc", "abc") ?? 9) < (fuzzyScore("abc", "axbxc") ?? 9)); // tighter scores lower
});

test("fuzzyFilter: ranks matches; empty query → first N", () => {
  const cands = ["readme.md", "src/reader.ts", "src/main.ts"];
  const hits = fuzzyFilter("read", cands);
  assert.ok(hits.includes("readme.md") && hits.includes("src/reader.ts"));
  assert.ok(!hits.includes("src/main.ts")); // no 'read' subsequence
  assert.deepEqual(fuzzyFilter("", cands, 2), ["readme.md", "src/reader.ts"]);
});

test("mentionQuery: finds an @token at the cursor", () => {
  assert.deepEqual(mentionQuery("see @src/ma", 11), { query: "src/ma", start: 4 });
  assert.equal(mentionQuery("hello world", 5), null);
});

test("applyMention: replaces the @token with the path + trailing space", () => {
  const r = applyMention("x @sr", 5, "src/main.ts");
  assert.equal(r.text, "x src/main.ts ");
  assert.equal(r.cursor, r.text.length);
});
