// The single-agent control loop — the core of the harness.
//
// Ties together the model client, tool registry and permission gate.
// Implements the turn lifecycle plus arg validation + repair, loop guards,
// and a denial circuit-breaker — extra scaffolding a local model needs.
//
// Turn lifecycle:
//   build [system?, user] -> chat(with tools) -> if no tool_calls => DONE
//   else for each tool_call: validate args -> permission decide -> run/deny/ask
//   -> append tool results -> next turn, until DONE / maxTurns / circuit-breaker.

import { type ChatMessage, type ToolCall, type ChatResult } from "../model/ollamaClient.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { ToolRegistry, type ToolContext } from "../tools/tools.ts";
import { PermissionEngine, requestFromTool, type PermissionDecision } from "../permissions/permissions.ts";
import { recoverToolCallsFromContent, stripThink } from "../agent/toolCallRecovery.ts";
import { Semaphore } from "../orchestration/gate.ts";
import { shouldCompact, compactConversation, truncateToolResults, type CompactionOptions } from "../state/compaction.ts";

export interface AskInfo {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}
/** Interactive approval callback for "ask" decisions. Returns true to allow. */
export type AskHandler = (info: AskInfo) => Promise<boolean> | boolean;

export type AgentEvent =
  | { type: "assistant"; text: string; toolCalls: ToolCall[]; turn: number }
  | { type: "tool_result"; tool: string; decision: PermissionDecision; content: string; turn: number }
  | { type: "compaction"; summarized: number; truncatedChars?: number; turn: number }
  | { type: "reflection"; reason: "tool_error" | "repeated_denial"; turn: number }
  | { type: "warning"; code: string; message: string; turn: number }
  | { type: "context"; usedTokens: number; outTokens: number; numCtx: number; turn: number }
  | { type: "done"; reason: string; turns: number };

export interface RunAgentOptions {
  client: ModelClient;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  ctx: ToolContext;
  userMessage: string;
  model?: string;
  systemPrompt?: string;
  /** which tools to expose; default = all registered */
  toolNames?: string[];
  maxTurns?: number;
  /** approval callback for "ask"; default DENY (headless-safe, per docs) */
  onAsk?: AskHandler;
  /** observer for logging / streaming UI */
  onEvent?: (ev: AgentEvent) => void;
  /** triggered self-reflection after a detected problem (tool error / repeated denial); default: true */
  reflect?: boolean;
  /** optional concurrency gate; if set, each generation acquires one permit */
  gate?: Semaphore;
  /** stream tokens as they arrive (uses client.chatStream + onToken) */
  stream?: boolean;
  /** receives each streamed content chunk (only when stream is true) */
  onToken?: (chunk: string) => void;
  /** prior conversation to resume from (already-persisted; not re-emitted) */
  priorMessages?: ChatMessage[];
  /** called for each NEW message appended — wire to a Session for persistence */
  onMessage?: (msg: ChatMessage) => void;
  /** auto-compact the in-memory context when it nears the model's window */
  compaction?: CompactionOptions;
  /** abort the run AND the in-flight model request when this fires (Ctrl+C / exit) */
  signal?: AbortSignal;
}

export type StopReason = "completed" | "max_turns" | "circuit_breaker" | "aborted" | "loop";

export interface AgentResult {
  text: string;
  messages: ChatMessage[];
  turns: number;
  stopReason: StopReason;
}

const MAX_TURNS_DEFAULT = 10;
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_CONSECUTIVE_NUDGES = 1; // one reminder when a turn stalls; resets on tool-call progress
const NO_ACTION_NUDGE =
  "You did not call a tool or give an answer. Either call a tool now to do the work, or give your final answer.";

const NARRATION_RE =
  /\b(?:please|kindly|can you|could you|would you|let me|let['']s|i['']ll|i will|i['']m going to|i am going to|i can|i could|next,? i|we (?:can|could|should|need to|will))\b[^.\n]{0,40}?\b(?:read|re-?read|open|view|look at|check|inspect|examine|run|execute|search|grep|find|locate|list|cat|show|display|edit|write|create|modify|use the|call the|invoke)\b/i;
const NARRATION_NUDGE =
  'Do not describe the action or ask me to do it — emit the tool call yourself now, as JSON: {"name":"read_file","arguments":{"path":"<path>"}}. If the task is already done, give your 1-2 sentence final answer.';
const MAX_CONSECUTIVE_REPEATS = 2; // the 3rd identical tool-call turn in a row = a stuck loop -> stop
const MAX_REPAIR_ATTEMPTS = 3; // per-tool malformed-args budget: after this many, stop re-prompting that tool
const LOOP_WARNING =
  "You've repeated the same action without making progress. Try a different approach, or give your final answer.";
const MAX_REFLECTIONS_PER_RUN = 1; // at most one triggered self-check per run (cost-bounded; never per-turn)
const REFLECTION_PROMPT =
  "The last step hit a problem (a tool error or a blocked action). Briefly check: was the tool name and arguments right, or should you try a different tool or approach? Then take the corrected action, or give your final answer.";
// HW: shown ONCE when tools were offered but the model never emitted a real tool call all run (it only narrated /
// faked the tool protocol). Usually means the endpoint/model doesn't support function-calling (some /v1 gateways
// strip the `tools` parameter) — not something the harness can fix, so we make the failure legible.
const TOOLS_IGNORED_MSG =
  "The model produced text but emitted no tool calls all run, although tools were available — this endpoint/model may not support function-calling (some /v1 gateways strip the tools parameter). For agentic tasks, use a tool-capable model (a local Ollama coder model, or a /v1 provider that forwards tools).";

// How a resolved tool call moves the denial circuit-breaker counter.
type DenialEffect = "reset" | "increment" | "none";

interface ResolvedToolCall {
  id: string; // the originating tool_call id — links this result back to its call (required by /v1 providers)
  name: string;
  args: Record<string, unknown>;
  readOnly: boolean; // false when the tool is unknown -> never joins the read-only batch
  decision: PermissionDecision; // final decision used in the emitted event
  needsDispatch: boolean; // true => content is filled by registry.dispatch in phase B
  content: string; // final content if known now; "" placeholder until dispatched
  effect: DenialEffect;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const maxTurns = opts.maxTurns ?? MAX_TURNS_DEFAULT;
  const emit = opts.onEvent ?? (() => {});

  const messages: ChatMessage[] = [];
  // record() appends to the live conversation AND notifies the session (if any).
  // priorMessages are already persisted, so they are pushed without re-emitting.
  const record = (m: ChatMessage): void => {
    messages.push(m);
    opts.onMessage?.(m);
  };
  if (opts.priorMessages && opts.priorMessages.length > 0) {
    messages.push(...opts.priorMessages);
  } else if (opts.systemPrompt) {
    record({ role: "system", content: opts.systemPrompt });
  }
  record({ role: "user", content: opts.userMessage });

  let consecutiveDenials = 0;
  let consecutiveNudges = 0;
  let consecutiveRepeats = 0;
  let lastToolFingerprint = "";
  const perToolRepairAttempts = new Map<string, number>(); // tool name -> consecutive malformed-args attempts
  let reflectionsUsed = 0; // Help006: bounded triggered self-reflection
  // HW: detect an endpoint/model that ignores tool-calling, so the user gets a clear hint (not a silent narrate-loop).
  const toolsSent = opts.registry.toToolDefs(opts.toolNames).length > 0;
  let toolCallEverEmitted = false;
  let sawAttemptedToolUse = false; // the model tried to "use" a tool in TEXT (narration / fake protocol tag)
  let warnedToolsIgnored = false;
  const maybeWarnToolsIgnored = (turnNo: number): void => {
    if (toolsSent && !toolCallEverEmitted && sawAttemptedToolUse && !warnedToolsIgnored) {
      warnedToolsIgnored = true;
      emit({ type: "warning", code: "tools_ignored", message: TOOLS_IGNORED_MSG, turn: turnNo });
    }
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Stop before spending a generation if the run was aborted (Ctrl+C / exit).
    if (opts.signal?.aborted) {
      emit({ type: "done", reason: "aborted by user", turns: turn - 1 });
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      return { text: last?.content ?? "", messages, turns: turn - 1, stopReason: "aborted" };
    }
    // Only the GENERATION holds a gate permit (never tool exec / awaiting) so an
    // orchestrator awaiting its subagents can't deadlock the pool.
    const chatOpts = { model: opts.model, messages, tools: opts.registry.toToolDefs(opts.toolNames), signal: opts.signal };
    const onTok = opts.onToken ?? (() => {});
    const doChat = () => (opts.stream ? opts.client.chatStream(chatOpts, onTok) : opts.client.chat(chatOpts));
    let result: ChatResult;
    try {
      result = opts.gate ? await opts.gate.withPermit(doChat) : await doChat();
    } catch (err) {
      // An abort mid-generation surfaces as a fetch error — exit gracefully.
      if (opts.signal?.aborted) {
        emit({ type: "done", reason: "aborted by user", turns: turn });
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        return { text: last?.content ?? "", messages, turns: turn, stopReason: "aborted" };
      }
      throw err;
    }

    // Local models (esp. qwen2.5) often emit a tool call as JSON in `content` instead of the
    // structured tool_calls array — recover it. Strip qwen3 <think>…</think> FIRST so reasoning
    // never counts as a final answer or derails recovery.
    let toolCalls = result.toolCalls;
    let assistantText = stripThink(result.text);
    if (toolCalls.length === 0 && assistantText.trim()) {
      const recovered = recoverToolCallsFromContent(assistantText, (n) => opts.registry.has(n));
      if (recovered.toolCalls.length > 0) {
        toolCalls = recovered.toolCalls;
        assistantText = recovered.cleanedText;
      }
    }
    if (toolCalls.length > 0) toolCallEverEmitted = true;

    record({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    emit({ type: "assistant", text: assistantText, toolCalls, turn });
    // C1: surface how full the context window is (uses the REAL prompt-token count from this generation).
    if (opts.compaction?.numCtx) {
      emit({ type: "context", usedTokens: result.usage.promptTokens, outTokens: result.usage.evalTokens, numCtx: opts.compaction.numCtx, turn });
    }

    // No tool calls.
    if (toolCalls.length === 0) {
      // Idle/narration guard (nudge ONCE, resets on tool-call progress, so a model can't silently stall):
      //  - empty/think-only turn -> it produced nothing usable; or
      //  - the turn merely DESCRIBED/deferred a tool action (e.g. "Please read the file X") with no call.
      // Either way, push it to actually act this once. Bounded by MAX_CONSECUTIVE_NUDGES => never an infinite
      // loop; a genuine short answer (no action phrasing) still terminates immediately.
      const empty = assistantText.trim().length === 0;
      const narrated = !empty && NARRATION_RE.test(assistantText);
      // HW: the model trying to "use" a tool in TEXT — narration, or a fake tool-protocol tag (e.g. <tool_output>,
      // which recoverToolCallsFromContent can't turn into a real call). A signal the endpoint may be ignoring tools.
      if (narrated || /<tool_call|<tool_output|<function_call/i.test(assistantText)) sawAttemptedToolUse = true;
      if ((empty || narrated) && consecutiveNudges < MAX_CONSECUTIVE_NUDGES) {
        if (turn < maxTurns) {
          consecutiveNudges++;
          record({ role: "user", content: empty ? NO_ACTION_NUDGE : NARRATION_NUDGE });
        }
        continue;
      }
      maybeWarnToolsIgnored(turn);
      emit({ type: "done", reason: "model returned a final answer", turns: turn });
      return { text: assistantText, messages, turns: turn, stopReason: "completed" };
    }
    consecutiveNudges = 0; // a tool call = progress — allow future nudges again

    // Loop guard: a model stuck repeating the SAME tool call makes no progress. Fingerprint this
    // turn's tool calls; on the 3rd identical turn in a row, stop BEFORE running it again.
    const toolFingerprint = toolCalls
      .map((c) => `${c.function.name}:${JSON.stringify(c.function.arguments ?? {})}`)
      .join("|");
    if (toolFingerprint && toolFingerprint === lastToolFingerprint) {
      consecutiveRepeats++;
    } else {
      consecutiveRepeats = 0;
      lastToolFingerprint = toolFingerprint;
    }
    if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
      for (const c of toolCalls) {
        record({ role: "tool", content: "Skipped: stopped by the loop guard (same tool call repeated without progress).", tool_name: c.function.name, tool_call_id: c.id });
      }
      emit({ type: "done", reason: "loop: repeated the same tool call without progress", turns: turn });
      return {
        text: "Stopped: the model repeated the same action without making progress.",
        messages,
        turns: turn,
        stopReason: "loop",
      };
    }

    // Resolve a single tool call's decision WITHOUT dispatching it yet. Interactive
    // onAsk is awaited here (phase A) so prompts never race. Does not mutate
    // consecutiveDenials — it returns the effect, so single- and multi-call paths match.
    const resolveOne = async (call: ToolCall): Promise<ResolvedToolCall> => {
      const name = call.function.name;
      let args = call.function.arguments ?? {};
      const tool = opts.registry.get(name);
      const base = { id: call.id, name, args, readOnly: false, needsDispatch: false };
      if (!tool) {
        const content = `Error: unknown tool "${name}". Available: ${opts.registry.list().map((t) => t.name).join(", ")}.`;
        return { ...base, decision: "deny", content, effect: "none" };
      }
      args = coerceArgs(tool.parameters, args); // Help007: repair a stringified number/bool before validating
      const v = validateArgs(tool.parameters, args);
      if (!v.ok) {
        const attempts = (perToolRepairAttempts.get(name) ?? 0) + 1;
        perToolRepairAttempts.set(name, attempts);
        const why = `invalid arguments for ${name}: ${v.errors.join("; ")}`;
        if (attempts >= MAX_REPAIR_ATTEMPTS) {
          return { ...base, args, decision: "deny", effect: "increment", content: `Error: ${why}. Giving up on ${name} after ${attempts} malformed attempts — try a different approach.` };
        }
        return { ...base, args, decision: "deny", effect: "none", content: `Error: ${why}. Call it again with corrected arguments.` };
      }
      perToolRepairAttempts.delete(name); // valid call -> reset this tool's repair budget
      const verdict = opts.permissions.decide(requestFromTool(tool, args));
      if (verdict.decision === "allow") {
        return { id: call.id, name, args, readOnly: tool.readOnly, decision: "allow", needsDispatch: true, content: "", effect: "reset" };
      }
      if (verdict.decision === "ask") {
        const approved = opts.onAsk ? await opts.onAsk({ toolName: name, args, reason: verdict.reason }) : false;
        if (approved) {
          return { id: call.id, name, args, readOnly: tool.readOnly, decision: "allow", needsDispatch: true, content: "", effect: "reset" };
        }
        return { ...base, decision: "deny", content: `Permission denied by the user for ${name}. Do not retry; choose another approach.`, effect: "increment" };
      }
      return { ...base, decision: "deny", content: `Permission denied: ${verdict.reason}. Do not retry this; choose a safe alternative.`, effect: "increment" };
    };

    const applyEffect = (e: DenialEffect): void => {
      if (e === "reset") consecutiveDenials = 0;
      else if (e === "increment") consecutiveDenials++;
    };

    let sawToolFailure = false; // Help006: did this turn end in a tool crash / unknown-tool?
    if (toolCalls.length === 1) {
      // Fast path: identical to the original sequential behavior (no Promise.all overhead).
      const r = await resolveOne(toolCalls[0]);
      applyEffect(r.effect);
      if (r.needsDispatch) r.content = await opts.registry.dispatch(r.name, r.args, opts.ctx);
      record({ role: "tool", content: r.decision === "allow" ? wrapToolOutput(r.content) : r.content, tool_name: r.name, tool_call_id: r.id });
      emit({ type: "tool_result", tool: r.name, decision: r.decision, content: r.content, turn });
      sawToolFailure = isToolFailure(r.decision, r.content);
    } else {
      // Phase A: resolve every call in order (validation, permission, onAsk, denial effect).
      const resolved: ResolvedToolCall[] = [];
      for (const call of toolCalls) {
        const r = await resolveOne(call);
        applyEffect(r.effect);
        resolved.push(r);
      }
      // Phase B: allowed READ-ONLY calls run concurrently; allowed MUTATING calls run
      // sequentially afterwards (avoids same-file lost-update + read/markRead races).
      await Promise.all(
        resolved
          .filter((r) => r.needsDispatch && r.readOnly)
          .map((r) => opts.registry.dispatch(r.name, r.args, opts.ctx).then((out) => { r.content = out; })),
      );
      for (const r of resolved) {
        if (r.needsDispatch && !r.readOnly) r.content = await opts.registry.dispatch(r.name, r.args, opts.ctx);
      }
      // Phase C: record + emit in the ORIGINAL tool_calls order.
      for (const r of resolved) {
        record({ role: "tool", content: r.decision === "allow" ? wrapToolOutput(r.content) : r.content, tool_name: r.name, tool_call_id: r.id });
        emit({ type: "tool_result", tool: r.name, decision: r.decision, content: r.content, turn });
      }
      sawToolFailure = resolved.some((r) => isToolFailure(r.decision, r.content));
    }

    const hasNextTurn = turn < maxTurns;

    if (
      opts.reflect !== false &&
      hasNextTurn &&
      reflectionsUsed < MAX_REFLECTIONS_PER_RUN &&
      consecutiveRepeats !== 1 &&
      (sawToolFailure || consecutiveDenials === MAX_CONSECUTIVE_DENIALS - 1)
    ) {
      record({ role: "user", content: REFLECTION_PROMPT });
      emit({ type: "reflection", reason: sawToolFailure ? "tool_error" : "repeated_denial", turn });
      reflectionsUsed++;
    }

    // On the 2nd identical tool-call turn, warn the model once so it can break out before the hard stop.
    if (consecutiveRepeats === 1 && hasNextTurn) {
      record({ role: "user", content: LOOP_WARNING });
    }

    // Circuit breaker: a confused model retrying blocked actions forever.
    if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
      emit({ type: "done", reason: "circuit breaker: too many consecutive denials", turns: turn });
      return {
        text: "Stopped: too many consecutive permission denials.",
        messages,
        turns: turn,
        stopReason: "circuit_breaker",
      };
    }

    // Compact the in-memory context if the last prompt neared the window.
    // (Only the messages sent to the model are compacted; the session keeps the full log.)
    if (
      opts.compaction &&
      shouldCompact(result.usage.promptTokens, opts.compaction.numCtx, opts.compaction.threshold)
    ) {
      // (1) Cheap, model-free first: truncate oversized tool results (keep the
      //     most recent verbatim). Often enough on its own.
      const cap = opts.compaction.toolResultCap ?? 2000;
      const trunc = truncateToolResults(messages, cap, { keepLast: true });
      if (trunc.savedChars > 0) messages.splice(0, messages.length, ...trunc.messages);

      // (2) Re-check using the REAL prompt-token count minus the truncation savings.
      //     Only pay for an LLM summary if we're still over the window.
      const projected = result.usage.promptTokens - Math.ceil(trunc.savedChars / 4);
      if (shouldCompact(projected, opts.compaction.numCtx, opts.compaction.threshold)) {
        const compacted = await compactConversation(
          { client: opts.client, model: opts.model, gate: opts.gate },
          messages,
          { keepRecent: opts.compaction.keepRecent },
        );
        if (compacted.summarized > 0) {
          messages.splice(0, messages.length, ...compacted.messages);
          emit({ type: "compaction", summarized: compacted.summarized, truncatedChars: trunc.savedChars, turn });
        } else if (trunc.savedChars > 0) {
          emit({ type: "compaction", summarized: 0, truncatedChars: trunc.savedChars, turn });
        }
      } else if (trunc.savedChars > 0) {
        // Truncation alone brought us back under the window — skip the LLM summary.
        emit({ type: "compaction", summarized: 0, truncatedChars: trunc.savedChars, turn });
      }
    }
  }

  maybeWarnToolsIgnored(maxTurns);
  emit({ type: "done", reason: "reached max turns", turns: maxTurns });
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    text: lastAssistant?.content ?? "",
    messages,
    turns: maxTurns,
    stopReason: "max_turns",
  };
}

// --------- minimal zero-dep JSON-Schema argument validator ---------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = (schema.required ?? []) as string[];

  for (const r of required) {
    if (!(r in args) || args[r] === undefined || args[r] === null) {
      errors.push(`missing required property "${r}"`);
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false) errors.push(`unexpected property "${key}"`);
      continue;
    }
    if (spec.type && !typeOk(spec.type, val)) {
      errors.push(`property "${key}" should be ${spec.type}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function typeOk(type: string, val: unknown): boolean {
  switch (type) {
    case "string":
      return typeof val === "string";
    case "number":
      return typeof val === "number";
    case "integer":
      return typeof val === "number" && Number.isInteger(val);
    case "boolean":
      return typeof val === "boolean";
    case "object":
      return val !== null && typeof val === "object" && !Array.isArray(val);
    case "array":
      return Array.isArray(val);
    default:
      return true;
  }
}

/**
 * Help007: repair common small-model arg-type mistakes BEFORE validation — a stringified number/integer → number,
 * a stringified boolean → boolean, per the tool's JSON-schema `properties[key].type`. Pure (returns a new object);
 * leaves anything it can't safely coerce untouched, so validation still reports the real error.
 */
export function coerceArgs(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const out: Record<string, unknown> = { ...args };
  for (const [key, val] of Object.entries(out)) {
    if (typeof val !== "string") continue;
    const type = props[key]?.type;
    if (type === "number" && val.trim() !== "" && Number.isFinite(Number(val))) {
      out[key] = Number(val);
    } else if (type === "integer" && val.trim() !== "" && Number.isInteger(Number(val))) {
      out[key] = Number(val); // only coerce when the value is genuinely an integer (12.5 stays a string -> validation reports it)
    } else if (type === "boolean" && (val === "true" || val === "false")) {
      out[key] = val === "true";
    }
  }
  return out;
}

/** Help003: wrap tool/file output so the model treats it as DATA, not instructions (prompt-injection mitigation). */
export function wrapToolOutput(content: string): string {
  return `<tool_output>\n${content}\n</tool_output>`;
}

/**
 * Help006: did this resolved call end in a DETECTED failure — a tool runtime crash (`Error running …` from the
 * dispatch wrapper) or an unknown-tool deny? Excludes invalid-args / permission denials (the Help007 repair budget
 * and the denial counter own those). Centralised so the error-string coupling is in one place + unit-tested.
 */
export function isToolFailure(decision: PermissionDecision, content: string): boolean {
  if (decision === "allow") return content.startsWith("Error running ");
  if (decision === "deny") return content.startsWith('Error: unknown tool');
  return false;
}
