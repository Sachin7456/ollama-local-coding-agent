// Auto-tests: pure rounded box-drawing + search field.

import { test } from "node:test";
import assert from "node:assert/strict";
import { roundBox, searchBox } from "../src/ui/box.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { stringWidth, stripAnsi } from "../src/ui/width.ts";

test("roundBox: rounded corners, content padded, exact width", () => {
  const lines = stripAnsi(roundBox("hi", 10, makeTheme(false))).split("\n");
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[1], /^│ hi\s+│$/);
  assert.match(lines[2], /^╰─+╯$/);
  for (const l of lines) assert.equal(stringWidth(l), 10); // every row fills the width
});

test("searchBox: ⌕ + query, else a Search… placeholder", () => {
  assert.match(stripAnsi(searchBox("todo", 24, makeTheme(false))), /⌕ todo/);
  assert.match(stripAnsi(searchBox("", 24, makeTheme(false))), /⌕ Search…/);
});
