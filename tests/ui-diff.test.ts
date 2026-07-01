// Auto-tests: unified-diff detection + colorization. Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeDiff, renderDiff, diffStats, formatDiffStat, computeLineDiff } from "../src/ui/diff.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { stripAnsi } from "../src/ui/width.ts";

test("looksLikeDiff: hunk header or multiple +/- lines", () => {
  assert.equal(looksLikeDiff("@@ -1,2 +1,3 @@\n context"), true);
  assert.equal(looksLikeDiff("+added\n-removed"), true);
  assert.equal(looksLikeDiff("just a normal message"), false);
});

test("diffStats: counts +/- content lines, ignores +++/--- headers", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+another add";
  assert.deepEqual(diffStats(diff), { added: 2, removed: 1 });
  assert.deepEqual(diffStats("no diff here"), { added: 0, removed: 0 });
});

test("computeLineDiff: @@ header + changed lines; detected + counted; empty when unchanged", () => {
  const d = computeLineDiff("hellow sachin", "hellow ram", "f.txt");
  assert.match(d, /^@@ f\.txt @@/);
  assert.match(d, /-hellow sachin/);
  assert.match(d, /\+hellow ram/);
  assert.equal(looksLikeDiff(d), true); // 1-line change still recognized (via @@ header)
  assert.deepEqual(diffStats(d), { added: 1, removed: 1 });
  assert.equal(computeLineDiff("same", "same", "f"), ""); // unchanged → empty
  assert.match(computeLineDiff("", "a\nb", "new.txt"), /\+a\n\+b/); // new file → all additions
});

test("formatDiffStat: +N -N (green/red), ±0 when empty", () => {
  assert.equal(stripAnsi(formatDiffStat(2, 1, makeTheme(true))), "+2 -1");
  assert.equal(formatDiffStat(3, 0, makeTheme(false)), "+3");
  assert.equal(formatDiffStat(0, 0, makeTheme(false)), "±0");
});

test("renderDiff: colors add/del/hunk; plain preserves the text", () => {
  const diff = "@@ -1 +1 @@\n-old\n+new";
  const plain = renderDiff(diff, makeTheme(false));
  assert.equal(plain, diff); // theme off → identical text
  const themed = renderDiff(diff, makeTheme(true));
  assert.ok(themed.includes("\x1b["));
  assert.equal(stripAnsi(themed), diff); // styling only, content unchanged
});
