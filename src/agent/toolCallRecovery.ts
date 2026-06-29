// Qwen tool-call "content-embedded" recovery.
//
// Real-world failure (caught by the live smoke test): qwen2.5-coder often emits a tool
// call as a JSON blob in `content` instead of the structured `tool_calls` array
// (and qwen3-coder sometimes emits its XML/Hermes `<tool_call>` form). When the
// client reports NO structured tool_calls but the text looks like a tool call,
// recover it so the agent loop can still act.
//
// Gated on a known-tool predicate so a normal JSON *answer* is never mistaken for
// a tool call.

import { randomUUID } from "node:crypto";
import type { ToolCall } from "../model/ollamaClient.ts";

export interface RecoveredCalls {
  toolCalls: ToolCall[];
  /** the content with recognized tool-call blobs removed */
  cleanedText: string;
}

/**
 * Remove qwen3-style `<think>…</think>` reasoning from model content. Pure + idempotent.
 * Handles paired blocks, a lone leading `</think>` (the open tag eaten by the chat template),
 * and an unclosed/truncated `<think>` — so reasoning never masquerades as a final answer or
 * derails JSON extraction. (No-op when a model returns reasoning in a separate field instead.)
 */
export function stripThink(content: string): string {
  if (!content) return content;
  let out = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = out.search(/<\/think>/i);
  if (close >= 0 && !/<think>/i.test(out.slice(0, close))) {
    out = out.slice(close).replace(/<\/think>/i, "");
  }
  out = out.replace(/<think>[\s\S]*$/i, "");
  return out.trim();
}

export function recoverToolCallsFromContent(
  content: string,
  isKnownTool?: (name: string) => boolean,
): RecoveredCalls {
  content = stripThink(content); // reasoning must never be parsed as a call or masquerade as text
  if (!content || !content.trim()) return { toolCalls: [], cleanedText: content };
  let text = content;
  const calls: ToolCall[] = [];

  // 1. Hermes-style <tool_call> ... </tool_call> blocks (qwen2.5 / qwen3 content form)
  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, body: string) => {
    const c = tryParseCall(body, isKnownTool);
    if (c) {
      calls.push(c);
      return "";
    }
    return whole;
  });

  // 2. fenced code blocks ```json {...} ``` / ```tool_call {...} ``` / ``` {...} ```
  text = text.replace(/```(?:json|tool_call|tool)?\s*([\s\S]*?)```/g, (whole, body: string) => {
    const c = tryParseCall(body, isKnownTool);
    if (c) {
      calls.push(c);
      return "";
    }
    return whole;
  });

  // 3. a bare JSON object somewhere in the text (e.g. the whole content is the call)
  if (calls.length === 0) {
    const c = tryParseCall(text, isKnownTool);
    if (c) {
      calls.push(c);
      text = "";
    }
  }

  // 4. Function-call syntax the model wrote as prose: KNOWN_TOOL({...}) or KNOWN_TOOL(key="v", k2=3).
  //    Gated on a known tool name + real structured args + dominance, so a final answer that merely
  //    MENTIONS a tool call is left untouched.
  if (calls.length === 0) {
    const fc = recoverFunctionCallSyntax(text, isKnownTool);
    if (fc) {
      calls.push(...fc.calls);
      text = fc.cleanedText;
    }
  }

  return { toolCalls: calls, cleanedText: text.trim() };
}

function tryParseCall(s: string, isKnownTool?: (name: string) => boolean): ToolCall | null {
  const obj = extractJsonObject(s);
  if (!obj) return null;
  const name =
    typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : "";
  if (!name) return null;
  if (isKnownTool && !isKnownTool(name)) return null;
  const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? {};
  const args =
    typeof rawArgs === "string"
      ? safeParseObject(rawArgs)
      : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
  return { id: randomUUID(), function: { name, arguments: args } };
}

/** Extract the first balanced {...} JSON object from a string (quote/escape aware). */
export function extractJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function safeParseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- function-call-syntax recovery (KNOWN_TOOL(args) the model wrote as prose) ----

const CALL_DOMINANCE = 0.5; // recovered call text must be >= half the trimmed content (prose-safe)
const UNPARSEABLE = Symbol("unparseable");

/** Find `KNOWN_TOOL(args)` calls in prose. Returns null unless the call(s) dominate the content. */
function recoverFunctionCallSyntax(
  text: string,
  isKnownTool?: (name: string) => boolean,
): { calls: ToolCall[]; cleanedText: string } | null {
  if (!isKnownTool) return null;
  const trimmedLen = text.trim().length;
  if (trimmedLen === 0) return null;
  const calls: ToolCall[] = [];
  const spans: Array<[number, number]> = [];
  let matchedChars = 0;
  const idRe = /(^|[^\w.])([A-Za-z_]\w*)\s*\(/g; // a name (not after a word char or ".") then "("
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(text)) !== null) {
    const name = m[2];
    if (!isKnownTool(name)) continue;
    const openIdx = m.index + m[0].length - 1; // index of "("
    const bal = extractBalancedParens(text, openIdx);
    if (!bal) continue;
    const args = parseCallArgs(bal.inner);
    if (!args) continue; // empty/ambiguous args -> prose, skip
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = bal.end + 1;
    calls.push({ id: randomUUID(), function: { name, arguments: args } });
    spans.push([start, end]);
    matchedChars += end - start;
    idRe.lastIndex = end;
  }
  if (calls.length === 0) return null;
  if (matchedChars < trimmedLen * CALL_DOMINANCE) return null; // dominance guard (prose-safe)
  let cleaned = text;
  for (let i = spans.length - 1; i >= 0; i--) cleaned = cleaned.slice(0, spans[i][0]) + cleaned.slice(spans[i][1]);
  return { calls, cleanedText: cleaned.trim() };
}

/** Args inside the parens: a JSON object, else key=value kwargs, else null (ambiguous). */
function parseCallArgs(inner: string): Record<string, unknown> | null {
  const s = inner.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    const o = extractJsonObject(s);
    if (o) return o;
  }
  return parseKwargs(s);
}

/** Balanced "(...)" starting at s[openIdx]==='('. Quote/escape aware. */
function extractBalancedParens(s: string, openIdx: number): { inner: string; end: number } | null {
  let depth = 0;
  let inStr = false;
  let q = "";
  let esc = false;
  for (let i = openIdx; i < s.length; i++) {
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
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

/** `key="v", k2=3, flag=true` -> object; null if any part isn't a clean key=value. */
function parseKwargs(s: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const part of splitTopLevelCommas(s)) {
    const eq = findTopLevelEq(part);
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(key)) return null;
    const val = parseScalar(part.slice(eq + 1).trim());
    if (val === UNPARSEABLE) return null;
    out[key] = val;
    count++;
  }
  return count > 0 ? out : null;
}

/** Split on commas NOT inside quotes or () [] {}. */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let q = "";
  let esc = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
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
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** First top-level "=" that is assignment (not ==, !=, <=, >=). -1 if none. */
function findTopLevelEq(s: string): number {
  let inStr = false;
  let q = "";
  let esc = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
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
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "=" && depth === 0 && s[i + 1] !== "=" && s[i - 1] !== "!" && s[i - 1] !== "<" && s[i - 1] !== ">") return i;
  }
  return -1;
}

/** Scalar value: quoted string, number, boolean, null/None, JSON array/object, or a bare token. */
function parseScalar(s: string): unknown {
  if (!s) return UNPARSEABLE;
  const c = s[0];
  if (c === '"' || c === "'") {
    if (c === '"') {
      try {
        return JSON.parse(s);
      } catch {
        /* fall through to lax handling */
      }
    }
    if (s.length >= 2 && s[s.length - 1] === c) return s.slice(1, -1);
    return UNPARSEABLE;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "None") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (c === "[" || c === "{") {
    try {
      return JSON.parse(s);
    } catch {
      return UNPARSEABLE;
    }
  }
  if (/^[\w./\-]+$/.test(s)) return s; // bare token, e.g. path=config.json
  return UNPARSEABLE;
}
