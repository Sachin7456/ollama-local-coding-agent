// Auto-tests: terminal display-width measurement, truncation, wrapping. Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { charWidth, stringWidth, stripAnsi, truncateToWidth, wrap } from "../src/ui/width.ts";

test("charWidth: ascii=1, CJK=2, emoji=2, combining/control=0", () => {
  assert.equal(charWidth("a".codePointAt(0)!), 1);
  assert.equal(charWidth("中".codePointAt(0)!), 2);
  assert.equal(charWidth(0x1f600), 2); // 😀
  assert.equal(charWidth(0x0301), 0); // combining acute accent
  assert.equal(charWidth(9), 0); // tab/control
});

test("stringWidth: sums cells and ignores ANSI escapes", () => {
  assert.equal(stringWidth("ab"), 2);
  assert.equal(stringWidth("中文"), 4);
  assert.equal(stringWidth("\x1b[31mhi\x1b[39m"), 2); // color codes contribute nothing
  assert.equal(stripAnsi("\x1b[1mX\x1b[22m"), "X");
});

test("truncateToWidth: cuts to display cells with an ellipsis", () => {
  assert.equal(stringWidth(truncateToWidth("hello world", 6)) <= 6, true);
  assert.ok(truncateToWidth("hello world", 6).endsWith("…"));
  assert.equal(truncateToWidth("hi", 10), "hi"); // already fits → unchanged
});

test("wrap: greedy word-wrap to cols, preserves newlines, hard-breaks long tokens", () => {
  const w = wrap("aa bb cc dd", 5);
  for (const line of w.split("\n")) assert.ok(stringWidth(line) <= 5);
  assert.ok(w.includes("\n"));
  assert.equal(wrap("line1\nline2", 80), "line1\nline2"); // short lines untouched
  const hard = wrap("abcdefghij", 4); // one token longer than cols
  for (const line of hard.split("\n")) assert.ok(stringWidth(line) <= 4);
});
