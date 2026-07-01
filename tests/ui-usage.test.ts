// Auto-tests: pure session token/cost tally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTally, addTurn, estimateCost, formatUsage } from "../src/ui/usage.ts";

test("addTurn accumulates tokens + turns; negatives clamped", () => {
  let t = emptyTally();
  t = addTurn(t, 100, 40);
  t = addTurn(t, 250, 60);
  t = addTurn(t, -5, -5); // clamped to 0
  assert.deepEqual(t, { input: 350, output: 100, turns: 3 });
});

test("estimateCost: 0 without a price; priced per million", () => {
  const t = { input: 1_000_000, output: 500_000, turns: 1 };
  assert.equal(estimateCost(t), 0);
  assert.equal(estimateCost(t, { inPerM: 3, outPerM: 15 }), 3 + 7.5);
});

test("formatUsage: local = free; with price = labeled estimate + grouped numbers", () => {
  const t = { input: 12345, output: 6789, turns: 2 };
  const local = formatUsage(t);
  assert.match(local, /2 turn\(s\)/);
  assert.match(local, /12,345 in \/ 6,789 out/);
  assert.match(local, /free/);
  assert.match(formatUsage(t, { price: { inPerM: 3, outPerM: 15 } }), /\$[\d.]+ \(estimate\)/);
});
