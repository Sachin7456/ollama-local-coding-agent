// Colorize unified-diff text (for write/edit tool results that include a diff). Additions green, deletions red,
// hunk headers accented, file headers dimmed. If the text isn't a diff, the caller renders it normally.

import { type Theme, makeTheme } from "./theme.ts";

/** Heuristic: does this look like a unified diff (a hunk header, or several +/- lines)? */
export function looksLikeDiff(text: string): boolean {
  if (/^@@.*@@/m.test(text)) return true;
  const marks = (text.match(/^[+-]/gm) ?? []).length;
  return marks >= 2;
}

/**
 * Compute a compact line diff (changed lines only) between old and new text, prefixed with a `@@ label @@` header
 * so it's always recognized as a diff (even a 1-line change). LCS-based; capped for display; "" when unchanged.
 * PURE — used by the write/edit tools so their results render as a colorized diff with a +N -N summary.
 */
export function computeLineDiff(oldText: string, newText: string, label = "", maxLines = 200): string {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const head = `@@ ${label} @@`;
  if (a.length * b.length > 2_000_000) {
    const net = Math.abs(b.length - a.length);
    return `${head}\n${b.length >= a.length ? "+" : "-"} (${net} net lines changed; diff too large to show)`;
  }
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      changed.push("-" + a[i++]);
    } else {
      changed.push("+" + b[j++]);
    }
  }
  while (i < m) changed.push("-" + a[i++]);
  while (j < n) changed.push("+" + b[j++]);
  if (changed.length === 0) return "";
  if (changed.length > maxLines) return [head, ...changed.slice(0, maxLines), `… (+${changed.length - maxLines} more)`].join("\n");
  return [head, ...changed].join("\n");
}

/** Count added/removed lines in a unified diff (ignoring the +++/--- file headers). */
export function diffStats(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    if (/^\+\+\+/.test(line) || /^---/.test(line)) continue; // file headers, not content
    if (/^\+/.test(line)) added += 1;
    else if (/^-/.test(line)) removed += 1;
  }
  return { added, removed };
}

/** A compact "+N -N" summary, green/red (NO_COLOR-safe via the theme). */
export function formatDiffStat(added: number, removed: number, theme: Theme = makeTheme(false)): string {
  const parts: string[] = [];
  if (added > 0) parts.push(theme.diffAdd(`+${added}`));
  if (removed > 0) parts.push(theme.diffDel(`-${removed}`));
  return parts.length > 0 ? parts.join(" ") : theme.dim("±0");
}

export function renderDiff(text: string, theme: Theme = makeTheme(false)): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^@@/.test(line)) return theme.accent(line);
      if (/^(\+\+\+|---)/.test(line)) return theme.dim(line); // file headers
      if (/^\+/.test(line)) return theme.diffAdd(line);
      if (/^-/.test(line)) return theme.diffDel(line);
      return theme.dim(line);
    })
    .join("\n");
}
