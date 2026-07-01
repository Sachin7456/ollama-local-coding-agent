// The status line shown above the prompt: model · mode · cwd · context% · session. Themed + width-aware
// (truncated to the terminal columns so it never wraps). Pure → unit-testable; the caller supplies the parts.

import path from "node:path";
import os from "node:os";
import { type Theme, makeTheme } from "./theme.ts";
import { truncateToWidth, stringWidth } from "./width.ts";

export interface StatusParts {
  model: string;
  mode: string;
  cwd: string;
  contextPct?: number; // 0..1
  sessionId?: string;
  tokensIn?: number; // running session prompt tokens (↑ sent)
  tokensOut?: number; // running session generated tokens (↓ received)
}

/** Coarse "time ago" for picker rows: <60s → "just now", then Nm/Nh/Nd ago. Pure (caller passes `now`). */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact token count for the status line: 999 → "999", 1500 → "1.5k", 1_200_000 → "1.2M". */
export function compactTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** Replace the home prefix with ~ and keep the path short for the status line. */
export function shortCwd(cwd: string, home: string = os.homedir()): string {
  const norm = cwd.replace(/[\\/]+$/, "");
  if (home && (norm === home || norm.startsWith(home + path.sep))) return "~" + norm.slice(home.length);
  return norm;
}

export function formatStatusLine(parts: StatusParts, cols = 80, theme: Theme = makeTheme(false)): string {
  const segs: string[] = [theme.accent(parts.model), theme.dim(parts.mode), theme.dim(shortCwd(parts.cwd))];
  if (typeof parts.contextPct === "number") {
    const pct = `ctx ${Math.round(Math.max(0, Math.min(1, parts.contextPct)) * 100)}%`;
    segs.push(parts.contextPct >= 0.75 ? theme.warn(pct) : theme.dim(pct));
  }
  if (typeof parts.tokensIn === "number" || typeof parts.tokensOut === "number") {
    segs.push(theme.dim(`↑${compactTokens(parts.tokensIn ?? 0)} ↓${compactTokens(parts.tokensOut ?? 0)}`));
  }
  if (parts.sessionId) segs.push(theme.dim(`sess ${parts.sessionId.slice(0, 8)}`));
  const sep = theme.dim(" · ");
  const line = segs.join(sep);
  // Truncate by DISPLAY width (ANSI-aware) so colored segments still fit the terminal.
  return stringWidth(line) <= cols ? line : truncateToWidth(line, cols);
}
