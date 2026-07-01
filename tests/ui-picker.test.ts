// Auto-tests: the generic numbered picker (formatting + reply parsing). Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPicker, parsePick } from "../src/ui/picker.ts";
import { makeTheme } from "../src/ui/theme.ts";

test("parsePick: 1-based number → 0-based index; blank/invalid/oob → null", () => {
  assert.equal(parsePick("2", 3), 1);
  assert.equal(parsePick(" 3 ", 3), 2);
  assert.equal(parsePick("", 3), null); // cancel
  assert.equal(parsePick("0", 3), null);
  assert.equal(parsePick("4", 3), null);
  assert.equal(parsePick("abc", 3), null);
});

test("formatPicker: numbered, marks active, shows badges", () => {
  const rows = [
    { label: "qwen2.5-coder:7b", active: true, badge: "installed" },
    { label: "gpt-oss-120b", badge: "remote" },
  ];
  const out = formatPicker(rows, makeTheme(false));
  assert.ok(out.includes("1)") && out.includes("2)"));
  assert.ok(out.includes("qwen2.5-coder:7b") && out.includes("gpt-oss-120b"));
  assert.ok(out.includes("●")); // active marker
  assert.ok(out.includes("(installed)") && out.includes("(remote)"));
  assert.ok(!out.includes("\x1b"));
  assert.ok(formatPicker(rows, makeTheme(true)).includes("\x1b[")); // themed
});
