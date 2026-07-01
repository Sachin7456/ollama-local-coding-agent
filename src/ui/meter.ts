// Context/token meter (C1). Renders "how full is the window" as a small bar + percentage, and flags when usage
// is approaching the auto-compaction threshold so the user gets a heads-up BEFORE the harness trims context.

import { type Theme, makeTheme } from "./theme.ts";

export interface MeterResult {
  line: string;
  pct: number; // 0..1
  warn: boolean; // approaching the auto-trim threshold
}

/** Warn once usage reaches (threshold − 0.15) — e.g. 60% for the default 0.75 auto-trim. */
const WARN_MARGIN = 0.15;

export function formatContextMeter(
  used: number,
  numCtx: number,
  threshold = 0.75,
  theme: Theme = makeTheme(false),
  barCells = 12,
): MeterResult {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return { line: theme.dim("context: unknown"), pct: 0, warn: false };
  }
  const pct = Math.max(0, Math.min(1, used / numCtx));
  const warn = pct >= Math.max(0, threshold - WARN_MARGIN);
  const filled = Math.max(0, Math.min(barCells, Math.round(pct * barCells)));
  const paint = pct >= threshold ? theme.meterWarn : theme.meterOk;
  const bar = paint("█".repeat(filled)) + theme.dim("░".repeat(barCells - filled));
  const pctStr = `${Math.round(pct * 100)}%`;
  let line = `context ${bar} ${pctStr} (${used}/${numCtx} tok)`;
  if (warn) line += theme.warn(` — nearing auto-trim at ${Math.round(threshold * 100)}%`);
  return { line, pct, warn };
}
