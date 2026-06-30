// Lenient JSON-object repair for tool-call arguments emitted by small/local models.
//
// Small models frequently emit *almost*-JSON arguments: single quotes, unquoted keys,
// Python literals (True/False/None), trailing commas, smart quotes, or a truncated /
// unterminated object. This recovers a plain object from such input with no dependency.
//
// It is strictly FAIL-SAFE: it tries strict JSON first, then a bounded set of quote-aware
// repairs (re-parsing after each), and returns null the moment it cannot produce a real
// object — callers then keep their existing fallback. It never throws and never guesses
// keys or values (a bare, unquoted value -> null, not an invented string).

type Obj = Record<string, unknown>;

function asObject(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function tryParse(s: string): Obj | null {
  try {
    return asObject(JSON.parse(s));
  } catch {
    return null;
  }
}

/**
 * The tightest `{...}` span starting at the first "{": the balanced end if present, else
 * to end-of-string (truncated — closeUnbalanced finishes it). Quote-aware for both ' and ".
 */
function objectCandidate(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let q = "";
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      q = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // unbalanced -> truncated
}

/** A5: straighten smart/curly quotes, but ONLY outside straight-double-quoted strings — so curly quotes that are
 * legitimate content inside a value are preserved, while curly DELIMITERS get straightened. Run before objectCandidate. */
function normalizeSmartQuotes(s: string): string {
  return mapOutsideStrings(s, (seg) => seg.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
}

/**
 * Convert single-quoted strings/keys to double-quoted JSON strings, leaving an apostrophe
 * inside a double-quoted string untouched (the riskiest step, so it is quote-state aware).
 */
function singleToDouble(s: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inDouble) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (esc) {
        esc = false;
        out += ch === "'" ? "'" : "\\" + ch; // \' -> ' (not a JSON escape); keep other escapes
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === "'") {
        out += '"';
        inSingle = false;
        continue;
      }
      out += ch === '"' ? '\\"' : ch; // escape a real double-quote that was inside single quotes
      continue;
    }
    if (ch === "'") {
      out += '"';
      inSingle = true;
    } else if (ch === '"') {
      out += '"';
      inDouble = true;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Apply fn only to the parts of s OUTSIDE double-quoted strings (so values are never rewritten). */
function mapOutsideStrings(s: string, fn: (seg: string) => string): string {
  let out = "";
  let buf = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      out += fn(buf);
      buf = "";
      out += ch;
      inStr = true;
    } else {
      buf += ch;
    }
  }
  return out + fn(buf);
}

function quoteBareKeys(s: string): string {
  return mapOutsideStrings(s, (seg) => seg.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'));
}

function pythonLiterals(s: string): string {
  return mapOutsideStrings(s, (seg) =>
    seg.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"),
  );
}

function stripTrailingCommas(s: string): string {
  return mapOutsideStrings(s, (seg) => seg.replace(/,(\s*[}\]])/g, "$1"));
}

/** Close any unbalanced "{"/"[" left open at the end (truncation). An UNTERMINATED string is intentionally NOT
 * completed (see A4): fabricating a closing quote forges a partial value (e.g. a write_file `content` cut off
 * mid-stream) into a "valid" one that gets written verbatim. Leave it unparseable → the caller's {} fallback. */
function closeUnbalanced(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) return s; // A4: truncated mid-string — do NOT fabricate a closing quote (fail-safe, no silent partial write)
  let out = s;
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

// Cumulative, re-parse after each, return on first success. stripTrailingCommas runs both
// before AND after closeUnbalanced (a freshly added closer can expose a trailing comma).
const REPAIRS: Array<(s: string) => string> = [
  (s) => s,
  singleToDouble,
  quoteBareKeys,
  pythonLiterals,
  stripTrailingCommas,
  closeUnbalanced,
  stripTrailingCommas,
];

/**
 * Best-effort parse of a JSON OBJECT from a (possibly malformed) string. Returns the object,
 * or null if it cannot be recovered safely. Never throws. Arrays / non-objects -> null.
 */
export function looseParseObject(s: string): Obj | null {
  if (typeof s !== "string" || s.indexOf("{") < 0) return null;
  const cand = objectCandidate(normalizeSmartQuotes(s)); // A5: straighten curly delimiters first (quote-aware), so the span scan is correct
  if (cand === null) return null;
  let cur = cand;
  for (const step of REPAIRS) {
    cur = step(cur);
    const parsed = tryParse(cur);
    if (parsed) return parsed;
  }
  return null;
}
