// reverseSearch — Ctrl+R incremental history search. PURE state machine (reducer + renderer); the controller wires
// keys + the persisted history. Type to filter; Ctrl+R cycles older matches; Enter accepts into the buffer; Esc cancels.

import type { Key } from "./io.ts";
import type { Theme } from "./theme.ts";
import { makeTheme } from "./theme.ts";

export interface SearchState {
  query: string;
  index: number; // into the current match list
}

export function makeSearch(): SearchState {
  return { query: "", index: 0 };
}

/** History entries (newest-first) containing the query (case-insensitive). Empty query → no matches. */
export function matches(history: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return history.filter((h) => h.toLowerCase().includes(q));
}

export interface SearchResult {
  state: SearchState;
  accept?: string; // chosen entry → put into the editor
  cancel?: boolean;
}

export function applyKey(s: SearchState, k: Key, history: string[]): SearchResult {
  if (k.name === "escape") return { state: s, cancel: true };
  const m = matches(history, s.query);
  if (k.name === "return") return { state: s, accept: m[s.index] ?? s.query };
  if (k.ctrl && k.name === "r") return { state: { ...s, index: Math.min(s.index + 1, Math.max(0, m.length - 1)) } };
  if (k.name === "backspace") return { state: { query: s.query.slice(0, -1), index: 0 } };
  if (!k.ctrl && !k.meta && k.sequence.length === 1 && k.sequence >= " ") {
    return { state: { query: s.query + k.sequence, index: 0 } };
  }
  return { state: s };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One-line overlay: `(reverse-search)`query`: <match with the query highlighted>`. */
export function renderSearch(s: SearchState, history: string[], theme: Theme = makeTheme(false)): string {
  const m = matches(history, s.query);
  const cur = m[s.index] ?? "";
  const shown = s.query && cur ? cur.replace(new RegExp(escapeRe(s.query), "gi"), (x) => theme.accent(x)) : cur;
  const count = m.length ? theme.dim(` [${s.index + 1}/${m.length}]`) : theme.dim(" (no match)");
  return theme.dim(`(reverse-search)\`${s.query}\`: `) + shown + count;
}
