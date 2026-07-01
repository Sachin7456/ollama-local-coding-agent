// Semantic theme: maps UI roles (not raw colors) to style functions, so the palette lives in ONE place and the
// rest of the UI never hard-codes a color. Built from a Style, so when color is disabled every role is identity.

import { type Style, makeStyle, detectColor, type ColorPref } from "./ansi.ts";

export interface Theme {
  enabled: boolean;
  /** assistant final text — left plain (most readable); kept as a role so it's themable later. */
  assistant: (s: string) => string;
  tool: (s: string) => string; // a tool CALL line
  toolResult: (s: string) => string; // a tool RESULT line
  warn: (s: string) => string;
  error: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string; // headings / emphasis / the prompt marker
  ok: (s: string) => string;
  meterOk: (s: string) => string;
  meterWarn: (s: string) => string;
  diffAdd: (s: string) => string;
  diffDel: (s: string) => string;
  statusBar: (s: string) => string;
  code: (s: string) => string; // inline code / fenced code
  bold: (s: string) => string; // markdown **strong**
  italic: (s: string) => string; // markdown *emphasis*
}

export function makeTheme(enabled: boolean): Theme {
  const c: Style = makeStyle(enabled);
  const id = (s: string): string => s;
  return {
    enabled,
    assistant: id,
    tool: c.cyan,
    toolResult: c.gray,
    warn: c.yellow,
    error: c.red,
    dim: c.dim,
    accent: (s) => c.bold(c.cyan(s)),
    ok: c.green,
    meterOk: c.green,
    meterWarn: c.yellow,
    diffAdd: c.green,
    diffDel: c.red,
    statusBar: c.dim,
    code: c.yellow,
    bold: c.bold,
    italic: c.italic,
  };
}

/** Build a theme from a color preference, deciding capability against the live stdout/env. */
export function themeFor(pref: ColorPref = "auto"): Theme {
  return makeTheme(detectColor(pref));
}
