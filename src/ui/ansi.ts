// Raw ANSI/SGR escape codes + a color-capability gate. Zero deps — just strings + Node's tty signals.
//
// We never auto-strip ANSI the harness writes; instead we decide ONCE whether to emit codes at all
// (colorEnabled) and build a Style whose functions are identity no-ops when color is off. This keeps
// piped/NO_COLOR/dumb-terminal output clean (and screen-reader friendly) without scattering `if (color)`.

const ESC = "\x1b[";

/** Bare SGR wrappers (open/close codes). Used only when color is enabled. */
const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
} as const;

const FG = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 } as const;
const BG = { red: 41, green: 42, yellow: 43, blue: 44 } as const;

export type ColorPref = "auto" | "always" | "never";

/**
 * Decide whether to emit color, given explicit inputs (pure → unit-testable). Precedence, research-backed:
 *   pref never/always win first; then NO_COLOR (presence disables, per no-color.org) and NODE_DISABLE_COLORS;
 *   then FORCE_COLOR ("0"/"" = off, else on); else auto = a real TTY that reports color support.
 */
export function colorEnabled(opts: {
  pref?: ColorPref;
  isTTY?: boolean;
  hasColors?: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  const pref = opts.pref ?? "auto";
  if (pref === "never") return false;
  if (pref === "always") return true;
  const env = opts.env ?? {};
  if (env.NO_COLOR !== undefined) return false;
  if (env.NODE_DISABLE_COLORS) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "";
  return Boolean(opts.isTTY) && opts.hasColors !== false;
}

/** Convenience: decide from the live stdout + env (defaults to process.stdout). */
export function detectColor(pref: ColorPref = "auto", stream: Partial<NodeJS.WriteStream> = process.stdout): boolean {
  const isTTY = Boolean(stream.isTTY);
  const hasColors = isTTY && typeof stream.hasColors === "function" ? stream.hasColors() : isTTY;
  return colorEnabled({ pref, isTTY, hasColors, env: process.env });
}

function sgr(open: number, close: number, s: string): string {
  return `${ESC}${open}m${s}${ESC}${close}m`;
}

/** A bundle of string→string style fns. When `enabled` is false EVERY fn is the identity (no codes emitted). */
export interface Style {
  enabled: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  italic: (s: string) => string;
  underline: (s: string) => string;
  inverse: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  bgRed: (s: string) => string;
  bgGreen: (s: string) => string;
}

const ID = (s: string): string => s;

export function makeStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      enabled: false,
      bold: ID, dim: ID, italic: ID, underline: ID, inverse: ID,
      red: ID, green: ID, yellow: ID, blue: ID, magenta: ID, cyan: ID, gray: ID, bgRed: ID, bgGreen: ID,
    };
  }
  const fg = (code: number) => (s: string) => sgr(code, 39, s);
  const bg = (code: number) => (s: string) => sgr(code, 49, s);
  return {
    enabled: true,
    bold: (s) => sgr(CODES.bold, 22, s),
    dim: (s) => sgr(CODES.dim, 22, s),
    italic: (s) => sgr(CODES.italic, 23, s),
    underline: (s) => sgr(CODES.underline, 24, s),
    inverse: (s) => sgr(CODES.inverse, 27, s),
    red: fg(FG.red),
    green: fg(FG.green),
    yellow: fg(FG.yellow),
    blue: fg(FG.blue),
    magenta: fg(FG.magenta),
    cyan: fg(FG.cyan),
    gray: fg(FG.gray),
    bgRed: bg(BG.red),
    bgGreen: bg(BG.green),
  };
}

/** Cursor / screen control (used by /clear and any redraw). Caller decides whether the stream is a TTY. */
export const CURSOR = {
  clearScreen: `${ESC}2J${ESC}H`, // erase screen + home
  clearLine: `${ESC}2K\r`, // erase current line + carriage return
};
