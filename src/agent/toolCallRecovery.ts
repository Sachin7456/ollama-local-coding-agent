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

  return { toolCalls: calls, cleanedText: text.trim() };
}

function tryParseCall(s: string, isKnownTool?: (name: string) => boolean): ToolCall | null {
  const obj = extractJsonObject(s);
  if (!obj) return null;
  const name =
    typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : "";
  if (!name) return null;
  if (isKnownTool && !isKnownTool(name)) return null;
  const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? {};
  const args =
    typeof rawArgs === "string"
      ? safeParseObject(rawArgs)
      : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
  return { function: { name, arguments: args } };
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
