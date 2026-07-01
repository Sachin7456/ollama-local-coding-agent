// Terminal display-width helpers. A terminal cell is NOT one JS char: a codepoint can occupy 0 (combining /
// zero-width), 1, or 2 (CJK / most emoji) cells, and ANSI/SGR escape bytes occupy none. Measuring with
// String.length mis-aligns wrapping, truncation and the status line, so we measure true display width.
//
// The width tables are PRAGMATIC (the common wide + zero-width ranges, per UAX #11), not a full Unicode DB —
// grapheme clusters / ZWJ-emoji widths still vary across terminals (documented tradeoff).

// Matches CSI sequences (colors, cursor moves, erases) so they contribute zero width.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

type Range = readonly [number, number];

// Zero-width: combining marks, bidi/zero-width controls, variation selectors, emoji skin-tone modifiers.
const ZERO: Range[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff],
];

// Wide (2 cells): Hangul, CJK, Kana, fullwidth forms, the main emoji/pictograph blocks.
const WIDE: Range[] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f9ff],
  [0x1fa00, 0x1faff], [0x20000, 0x3fffd],
];

function inRanges(cp: number, ranges: Range[]): boolean {
  // ranges are sorted + non-overlapping; a small linear scan is fine for our string sizes.
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** Cells a single codepoint occupies: 0 (control/combining/zero-width), 2 (wide), else 1. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 controls
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** Visible width of a string in terminal cells (ANSI stripped, per-codepoint width summed). */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) w += charWidth(cp);
  }
  return w;
}

/** Truncate to at most `max` display cells, appending `ellipsis` if it had to cut (ellipsis counts toward max). */
export function truncateToWidth(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (stringWidth(s) <= max) return s;
  const ellW = stringWidth(ellipsis);
  const budget = Math.max(0, max - ellW);
  let out = "";
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/**
 * Greedy word-wrap to `cols` display cells, preserving existing newlines. A single token wider than `cols` is
 * hard-broken by display width. Measurement is ANSI-aware; pre-styled short tokens wrap correctly.
 */
export function wrap(text: string, cols: number): string {
  if (cols <= 0) return text;
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (stringWidth(rawLine) <= cols) {
      out.push(rawLine);
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of rawLine.split(" ")) {
      const wordW = stringWidth(word);
      if (wordW > cols) {
        // flush, then hard-break the oversized token
        if (line) {
          out.push(line);
          line = "";
          lineW = 0;
        }
        let chunk = "";
        let chunkW = 0;
        for (const ch of word) {
          const cw = charWidth(ch.codePointAt(0) ?? 0);
          if (chunkW + cw > cols) {
            out.push(chunk);
            chunk = "";
            chunkW = 0;
          }
          chunk += ch;
          chunkW += cw;
        }
        line = chunk;
        lineW = chunkW;
        continue;
      }
      const need = lineW === 0 ? wordW : lineW + 1 + wordW;
      if (need > cols) {
        out.push(line);
        line = word;
        lineW = wordW;
      } else {
        line = lineW === 0 ? word : `${line} ${word}`;
        lineW = need;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
