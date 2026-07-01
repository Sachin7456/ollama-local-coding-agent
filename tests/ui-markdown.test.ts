// Auto-tests: pragmatic Markdown → ANSI (subset). Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInline, renderMarkdown } from "../src/ui/markdown.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { stripAnsi } from "../src/ui/width.ts";

test("renderInline: strips markers when plain, styles when themed", () => {
  assert.equal(renderInline("**bold** and `code` and *it*", makeTheme(false)), "bold and code and it");
  const themed = renderInline("**b**", makeTheme(true));
  assert.ok(themed.includes("\x1b[") && stripAnsi(themed) === "b");
});

test("renderMarkdown: headings, lists, blockquotes, fenced code (plain)", () => {
  const md = "# Title\n\n- one\n- two\n\n> note\n\n```\ncode line\n```";
  const out = renderMarkdown(md, makeTheme(false));
  assert.ok(out.includes("Title") && !out.includes("# Title")); // heading marker gone
  assert.ok(out.includes("• one") && out.includes("• two")); // bullets
  assert.ok(out.includes("│ note")); // blockquote
  assert.ok(out.includes("code line") && !out.includes("```")); // fence kept content, dropped markers
});

test("renderMarkdown: wraps long paragraphs to cols", () => {
  const out = renderMarkdown("aa bb cc dd ee ff", makeTheme(false), 6);
  assert.ok(out.includes("\n"));
});
