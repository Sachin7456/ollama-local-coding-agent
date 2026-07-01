// A generic numbered picker (used by `/model`, reusable for sessions later). Pure: one function formats the rows,
// another parses the user's reply. The interactive rl.question + the reply→action wiring live in main.ts.

import { type Theme, makeTheme } from "./theme.ts";

export interface PickerRow {
  label: string; // the value being chosen (e.g. a model tag)
  active?: boolean; // currently selected → marked ●
  badge?: string; // a short status, e.g. "installed" / "remote"
}

/** Numbered list; the active row is marked. Numbers are accented; badges dimmed. */
export function formatPicker(rows: PickerRow[], theme: Theme = makeTheme(false)): string {
  const width = String(rows.length).length;
  return rows
    .map((r, i) => {
      const n = theme.accent(String(i + 1).padStart(width));
      const mark = r.active ? theme.ok("●") : " ";
      const badge = r.badge ? theme.dim(`  (${r.badge})`) : "";
      return `  ${n}) ${mark} ${r.label}${badge}`;
    })
    .join("\n");
}

/** Parse a picker reply to a 0-based index, or null to cancel (blank / non-numeric / out-of-range). */
export function parsePick(input: string, count: number): number | null {
  const t = input.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (n < 1 || n > count) return null;
  return n - 1;
}
