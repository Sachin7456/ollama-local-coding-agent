// Context-window compaction.
//
// Designed for local models with SMALL windows. When the prompt approaches the
// model's num_ctx, fold
// the older middle of the conversation into a model-written summary, keeping the
// system message + the most recent messages verbatim, so the loop continues
// without the server silently truncating.
//
// Trigger signal = Ollama's real `prompt_eval_count` (from the last response) — the
// most accurate measure available — with a char/4 estimate as a fallback helper.
//
// IMPORTANT: compaction rewrites only the IN-MEMORY messages sent to the model.
// The session transcript stays a full append-only log (see session.ts).

import { type ChatMessage } from "../model/ollamaClient.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { Semaphore } from "../orchestration/gate.ts";

export interface CompactionOptions {
  /** the model's context window (pin from config). */
  numCtx: number;
  /** fraction of numCtx that triggers compaction (default 0.75). */
  threshold?: number;
  /** recent messages always kept verbatim (default 6). */
  keepRecent?: number;
  /** cap for truncating large tool-result contents before summarizing (default 2000). */
  toolResultCap?: number;
}

/** Rough token estimate (~4 chars/token). Good enough for thresholds. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(m.content) + 4; // small per-message overhead
    if (m.tool_calls && m.tool_calls.length) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

export function shouldCompact(promptTokens: number, numCtx: number, threshold = 0.75): boolean {
  return numCtx > 0 && promptTokens >= Math.floor(numCtx * threshold);
}

export interface TruncateResult {
  /** new array; truncated entries are NEW objects, untouched entries reuse the same refs. */
  messages: ChatMessage[];
  /** total characters removed across truncated tool messages. */
  savedChars: number;
}

/**
 * Cheap, model-free first step before summarizing: shorten oversized `role:"tool"`
 * message contents (file reads, command output) — usually the bulkiest, least dense
 * part of a long context. The most recent tool message is kept verbatim by default.
 *
 * Idempotent: a truncated message ends up shorter than `capChars` (since head < cap),
 * so a second pass changes nothing. Does not mutate the input array/objects.
 */
export function truncateToolResults(
  messages: ChatMessage[],
  capChars = 2000,
  opts: { head?: number; keepLast?: boolean } = {},
): TruncateResult {
  const head = Math.min(opts.head ?? 1500, capChars);
  const keepLast = opts.keepLast ?? true;
  let lastToolIdx = -1;
  if (keepLast) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "tool") {
        lastToolIdx = i;
        break;
      }
    }
  }
  let savedChars = 0;
  const out: ChatMessage[] = messages.map((m, i) => {
    if (m.role !== "tool") return m;
    if (i === lastToolIdx) return m;
    if (m.content.length <= capChars) return m;
    const removed = m.content.length - head;
    const newContent = m.content.slice(0, head) + `\n…[truncated ${removed} chars]`;
    savedChars += m.content.length - newContent.length;
    return { ...m, content: newContent };
  });
  return { messages: out, savedChars };
}

const SUMMARY_SYSTEM =
  "You compress conversations. Produce a concise but complete summary that lets the assistant continue the task without seeing the original messages.";

function serializeForSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      let line = `${m.role.toUpperCase()}: ${m.content}`;
      if (m.tool_calls && m.tool_calls.length) {
        line += ` [tool calls: ${m.tool_calls.map((t) => t.function.name).join(", ")}]`;
      }
      return line;
    })
    .join("\n");
}

export interface CompactionResult {
  messages: ChatMessage[];
  summarized: number; // how many messages were folded into the summary
}

/** Map each tool_call id → its assistant index + its result index (-1 = no result yet / orphaned). */
function findToolPairs(messages: ChatMessage[]): Map<string, { callIdx: number; resultIdx: number }> {
  const pairs = new Map<string, { callIdx: number; resultIdx: number }>();
  for (let i = 0; i < messages.length; i++) {
    const tc = messages[i].tool_calls;
    if (messages[i].role === "assistant" && tc && tc.length) {
      for (const c of tc) pairs.set(c.id, { callIdx: i, resultIdx: -1 });
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i].tool_call_id;
    if (messages[i].role === "tool" && id) {
      const p = pairs.get(id);
      if (p) p.resultIdx = i;
    }
  }
  return pairs;
}

/**
 * Push `tailStart` forward until no tool_call↔result pair straddles it — so the kept tail never holds a tool
 * result whose assistant tool_call was summarized away (or vice-versa). /v1 providers (Groq etc.) return 400 on
 * such an orphan; Ollama is lenient (keys by tool_name), so this is a transparent no-op there. Fixed-point:
 * moving the boundary past one pair can expose another, so we repeat until stable (tailStart only grows → ends).
 */
function pairSafeTailStart(messages: ChatMessage[], tailStart: number): number {
  const pairs = findToolPairs(messages);
  for (;;) {
    let moved = false;
    for (const { callIdx, resultIdx } of pairs.values()) {
      if (resultIdx < 0) continue; // in-flight / orphaned call — no result to split
      if (callIdx >= tailStart !== resultIdx >= tailStart) {
        tailStart = Math.max(tailStart, Math.max(callIdx, resultIdx) + 1); // pull the whole pair into the summary
        moved = true;
      }
    }
    if (!moved) return tailStart;
  }
}

/**
 * Produce a compacted message list: [system?, summary, ...recentTail].
 * Returns the input unchanged (summarized: 0) when there's nothing to compact.
 */
export async function compactConversation(
  deps: { client: ModelClient; model?: string; gate?: Semaphore },
  messages: ChatMessage[],
  opts: { keepRecent?: number } = {},
): Promise<CompactionResult> {
  const keepRecent = Math.max(2, opts.keepRecent ?? 6);
  const hasSystem = messages.length > 0 && messages[0].role === "system";
  const bodyStart = hasSystem ? 1 : 0;
  const total = messages.length;

  let tailStart = Math.max(bodyStart, total - keepRecent);
  // Never start the kept tail on an orphan tool message — a tool result must
  // follow its assistant tool_call, so push such messages into the summary.
  while (tailStart < total && messages[tailStart].role === "tool") tailStart++;
  // Never split a tool_call↔result pair across the summary/tail boundary (/v1 providers 400 on an orphan).
  tailStart = pairSafeTailStart(messages, tailStart);

  const middle = messages.slice(bodyStart, tailStart);
  if (middle.length === 0) return { messages, summarized: 0 };
  const tail = messages.slice(tailStart);

  const summaryPrompt =
    "Summarize the conversation so far. Preserve: the user's goal, key decisions, " +
    "important facts/values, file paths touched, what has been done, and what remains. " +
    "Be concise and structured.\n\n" +
    serializeForSummary(middle);

  const doSummary = () =>
    deps.client.chat({
      model: deps.model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: summaryPrompt },
      ],
    });
  const res = deps.gate ? await deps.gate.withPermit(doSummary) : await doSummary();
  const summaryText = res.text.trim() || "(summary unavailable)";

  const summaryMsg: ChatMessage = {
    role: "user",
    content: `[Summary of earlier conversation]\n${summaryText}`,
  };
  const compacted = hasSystem ? [messages[0], summaryMsg, ...tail] : [summaryMsg, ...tail];
  return { messages: compacted, summarized: middle.length };
}
