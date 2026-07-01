// fileMentions — the `@path` affordance. The scoring/token logic is PURE (unit-tested); only listFiles touches the
// filesystem. A subsequence fuzzy matcher ranks candidates; mentionQuery/applyMention find + replace the @token at
// the cursor. SRP: matching vs listing are separate.

import fs from "node:fs";
import path from "node:path";

/** Subsequence fuzzy score (lower = better); null if `query` is not a subsequence of `cand`. Case-insensitive. */
export function fuzzyScore(query: string, cand: string): number | null {
  const q = query.toLowerCase();
  const c = cand.toLowerCase();
  let ci = 0;
  let gaps = 0;
  for (const ch of q) {
    const idx = c.indexOf(ch, ci);
    if (idx === -1) return null;
    gaps += idx - ci;
    ci = idx + 1;
  }
  return gaps + Math.max(0, cand.length - query.length) * 0.1; // prefer tighter + shorter matches
}

/** Best `max` candidates for `query` (empty query → first `max`, unranked). */
export function fuzzyFilter(query: string, candidates: string[], max = 8): string[] {
  if (!query) return candidates.slice(0, max);
  const scored: { c: string; s: number }[] = [];
  for (const c of candidates) {
    const s = fuzzyScore(query, c);
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => a.s - b.s || a.c.length - b.c.length);
  return scored.slice(0, max).map((x) => x.c);
}

/** If the whitespace-delimited token ending at `cursor` starts with '@', return its query (sans @) + start index. */
export function mentionQuery(text: string, cursor: number): { query: string; start: number } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, cursor);
  return token.startsWith("@") ? { query: token.slice(1), start } : null;
}

/** Replace the @token at the cursor with `filePath` (+ a trailing space); returns the new text + cursor. */
export function applyMention(text: string, cursor: number, filePath: string): { text: string; cursor: number } {
  const m = mentionQuery(text, cursor);
  if (!m) return { text, cursor };
  const before = text.slice(0, m.start) + filePath + " ";
  return { text: before + text.slice(cursor), cursor: before.length };
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage"]);

/** Recursive workspace file list (relative, forward-slash), skipping heavy/dot dirs. Bounded by `max`. I/O. */
export function listFiles(cwd: string, max = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(cwd, "");
  return out;
}
