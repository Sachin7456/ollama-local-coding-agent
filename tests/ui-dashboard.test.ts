// Auto-tests: pure multi-agent dashboard aggregation + renderer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardTotals, renderDashboard, type AgentStat } from "../src/ui/dashboard.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { stripAnsi } from "../src/ui/width.ts";

const agents: AgentStat[] = [
  { label: "reviewer", tokens: 1500, done: true },
  { label: "fixer", tokens: 800, done: false },
];

test("dashboardTotals: done/total + summed tokens", () => {
  assert.deepEqual(dashboardTotals(agents), { done: 1, total: 2, tokens: 2300 });
});

test("renderDashboard: header totals + per-agent rows", () => {
  const out = stripAnsi(renderDashboard(agents, makeTheme(true)));
  assert.match(out, /agents 1\/2 · 2\.3k tok total/);
  assert.match(out, /✓ reviewer\s+1\.5k tok/);
  assert.match(out, /● fixer\s+800 tok/);
});
