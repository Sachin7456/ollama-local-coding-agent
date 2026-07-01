// box — PURE rounded box-drawing (SRP: framing text; no I/O). Used for the searchable picker's search field and,
// later, the pinned composer. Width-aware (ANSI-safe via stringWidth). Unit-testable — no terminal.

import { type Theme, makeTheme } from "./theme.ts";
import { stringWidth } from "./width.ts";

const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const H = "─";
const V = "│";

/** Frame `content` (may be multi-line, may contain ANSI) in a rounded box of the given total width. */
export function roundBox(content: string, width: number, theme: Theme = makeTheme(false)): string {
  const inner = Math.max(2, width) - 2; // columns available between the │ borders
  const top = theme.dim(TL + H.repeat(inner) + TR);
  const bot = theme.dim(BL + H.repeat(inner) + BR);
  const rows = content.split("\n").map((line) => {
    const pad = Math.max(0, inner - 1 - stringWidth(line));
    return theme.dim(V) + " " + line + " ".repeat(pad) + theme.dim(V);
  });
  return [top, ...rows, bot].join("\n");
}

/** A search field in a rounded box: "⌕ <query>" (or a dim "Search…" placeholder when empty). */
export function searchBox(query: string, width: number, theme: Theme = makeTheme(false)): string {
  const body = query ? `⌕ ${query}` : `⌕ ${theme.dim("Search…")}`;
  return roundBox(body, width, theme);
}
