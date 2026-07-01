// selectList — a PURE, reusable filter-and-select list state machine (SRP: list state only; no I/O). One widget
// (via OCP: items are DATA) powers the `/` command palette, the `/model` picker, the `/resume` picker and the
// plan-approval prompt. `applyKey` is a reducer; `renderList` produces the display. Fully unit-testable with plain
// Key objects — no terminal.

import type { Key } from "./io.ts";
import type { Theme } from "./theme.ts";
import { makeTheme } from "./theme.ts";

export interface ListItem<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface ListState<T> {
  items: ListItem<T>[];
  filter: string;
  index: number; // index into the FILTERED list
}

export function makeList<T>(items: ListItem<T>[]): ListState<T> {
  return { items, filter: "", index: 0 };
}

/** Case-insensitive substring filter over labels (no filter → all items). */
export function filtered<T>(s: ListState<T>): ListItem<T>[] {
  const f = s.filter.trim().toLowerCase();
  if (!f) return s.items;
  return s.items.filter((it) => it.label.toLowerCase().includes(f));
}

export interface ListResult<T> {
  state: ListState<T>;
  chosen?: T;
  cancelled?: boolean;
}

export function applyKey<T>(s: ListState<T>, k: Key): ListResult<T> {
  const list = filtered(s);
  if (k.name === "escape") return { state: s, cancelled: true };
  if (k.name === "return") {
    const it = list[s.index];
    return it ? { state: s, chosen: it.value } : { state: s };
  }
  if (k.name === "up") return { state: { ...s, index: Math.max(0, s.index - 1) } };
  if (k.name === "down") return { state: { ...s, index: Math.min(Math.max(0, list.length - 1), s.index + 1) } };
  if (k.name === "backspace") return { state: { ...s, filter: s.filter.slice(0, -1), index: 0 } };
  if (!k.ctrl && !k.meta && k.sequence.length === 1 && k.sequence >= " ") {
    return { state: { ...s, filter: s.filter + k.sequence, index: 0 } };
  }
  return { state: s };
}

/** Render the visible window of the filtered list, marking the selected row. Pure → returns a multi-line string. */
export function renderList<T>(s: ListState<T>, theme: Theme = makeTheme(false), max = 8): string {
  const list = filtered(s);
  if (list.length === 0) return theme.dim("  (no matches)");
  const start = Math.min(Math.max(0, s.index - max + 1), Math.max(0, list.length - max));
  const view = list.slice(start, start + max);
  const rows = view.map((it, i) => {
    const actual = start + i;
    const sel = actual === s.index;
    const marker = sel ? theme.accent("❯ ") : "  ";
    const label = sel ? theme.accent(it.label) : it.label;
    const hint = it.hint ? theme.dim("  " + it.hint) : "";
    return `${marker}${label}${hint}`;
  });
  if (list.length > view.length) rows.push(theme.dim(`  … +${list.length - view.length} more`));
  return rows.join("\n");
}
