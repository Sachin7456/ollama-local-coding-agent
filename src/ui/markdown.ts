// Pragmatic Markdown → ANSI for assistant answers. A coding agent needs a SUBSET (headings, emphasis, inline +
// fenced code, lists, blockquotes) — NOT tables/images/LaTeX (research: over-building the renderer is a known
// trap). Width-aware via wrap(). When the theme is disabled, markers are simply stripped (cleaner plain text).

import { type Theme, makeTheme } from "./theme.ts";
import { wrap } from "./width.ts";

/** Apply inline styles: `code`, **bold**, *italic*. Order matters (code first, bold before italic). */
export function renderInline(s: string, theme: Theme = makeTheme(false)): string {
  let out = s.replace(/`([^`]+)`/g, (_m, code: string) => theme.code(code));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => theme.bold(b));
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, (_m, pre: string, it: string) => pre + theme.italic(it));
  return out;
}

export function renderMarkdown(md: string, theme: Theme = makeTheme(false), cols = 80): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // toggle; the fence marker line itself is dropped
      continue;
    }
    if (inFence) {
      out.push(theme.code(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(theme.accent(renderInline(h[2], theme)));
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      out.push(theme.dim("│ ") + renderInline(q[1], theme));
      continue;
    }
    const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (b) {
      out.push(`${b[1]}${theme.accent("•")} ${renderInline(b[2], theme)}`);
      continue;
    }
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (n) {
      out.push(`${n[1]}${theme.accent(n[2] + ".")} ${renderInline(n[3], theme)}`);
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    out.push(wrap(renderInline(line, theme), cols));
  }
  return out.join("\n");
}
