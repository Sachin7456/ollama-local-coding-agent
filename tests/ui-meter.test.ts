// Auto-tests: the context/token meter (C1). Pure formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContextMeter } from "../src/ui/meter.ts";
import { makeTheme } from "../src/ui/theme.ts";

test("meter: percentage + token counts", () => {
  const r = formatContextMeter(0, 100);
  assert.equal(r.pct, 0);
  assert.equal(r.warn, false);
  assert.ok(r.line.includes("0%") && r.line.includes("0/100"));
});

test("meter: warns as it approaches the auto-trim threshold (default 60% for 0.75)", () => {
  assert.equal(formatContextMeter(50, 100, 0.75).warn, false); // below margin
  assert.equal(formatContextMeter(60, 100, 0.75).warn, true); // at the warn margin
  const hot = formatContextMeter(80, 100, 0.75);
  assert.equal(hot.warn, true);
  assert.ok(hot.line.includes("nearing auto-trim"));
});

test("meter: unknown window when numCtx<=0", () => {
  const r = formatContextMeter(10, 0);
  assert.equal(r.warn, false);
  assert.ok(/unknown/.test(r.line));
});

test("meter: themed when color enabled, plain otherwise", () => {
  assert.ok(!formatContextMeter(80, 100, 0.75, makeTheme(false)).line.includes("\x1b"));
  assert.ok(formatContextMeter(80, 100, 0.75, makeTheme(true)).line.includes("\x1b["));
});
