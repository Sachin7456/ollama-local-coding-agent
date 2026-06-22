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

import { OllamaClient, type ChatMessage, type ToolCall, type ChatResult } from "../model/ollamaClient.ts";
import { ToolRegistry, type ToolContext } from "../tools/tools.ts";
import { PermissionEngine, requestFromTool, type PermissionDecision } from "../permissions/permissions.ts";
import { recoverToolCallsFromContent } from "../agent/toolCallRecovery.ts";
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
  | { type: "done"; reason: string; turns: number };

export interface RunAgentOptions {
  client: OllamaClient;
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

export type StopReason = "completed" | "max_turns" | "circuit_breaker" | "aborted";

export interface AgentResult {
  text: string;
  messages: ChatMessage[];
  turns: number;
  stopReason: StopReason;
}

const MAX_TURNS_DEFAULT = 10;
const MAX_CONSECUTIVE_DENIALS = 3;

// How a resolved tool call moves the denial circuit-breaker counter.
type DenialEffect = "reset" | "increment" | "none";

interface ResolvedToolCall {
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

    // Local models (esp. qwen2.5) often emit a tool call as JSON in `content`
    // instead of the structured tool_calls array — recover it.
    let toolCalls = result.toolCalls;
    let assistantText = result.text;
    if (toolCalls.length === 0 && assistantText.trim()) {
      const recovered = recoverToolCallsFromContent(assistantText, (n) => opts.registry.has(n));
      if (recovered.toolCalls.length > 0) {
        toolCalls = recovered.toolCalls;
        assistantText = recovered.cleanedText;
      }
    }

    record({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    emit({ type: "assistant", text: assistantText, toolCalls, turn });

    // No tool calls => the model is answering. Done.
    if (toolCalls.length === 0) {
      emit({ type: "done", reason: "model returned a final answer", turns: turn });
      return { text: assistantText, messages, turns: turn, stopReason: "completed" };
    }

    // Resolve a single tool call's decision WITHOUT dispatching it yet. Interactive
    // onAsk is awaited here (phase A) so prompts never race. Does not mutate
    // consecutiveDenials — it returns the effect, so single- and multi-call paths match.
    const resolveOne = async (call: ToolCall): Promise<ResolvedToolCall> => {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      const tool = opts.registry.get(name);
      const base = { name, args, readOnly: false, needsDispatch: false };
      if (!tool) {
        const content = `Error: unknown tool "${name}". Available: ${opts.registry.list().map((t) => t.name).join(", ")}.`;
        return { ...base, decision: "deny", content, effect: "none" };
      }
      const v = validateArgs(tool.parameters, args);
      if (!v.ok) {
        const content = `Error: invalid arguments for ${name}: ${v.errors.join("; ")}. Call it again with corrected arguments.`;
        return { ...base, decision: "deny", content, effect: "none" };
      }
      const verdict = opts.permissions.decide(requestFromTool(tool, args));
      if (verdict.decision === "allow") {
        return { name, args, readOnly: tool.readOnly, decision: "allow", needsDispatch: true, content: "", effect: "reset" };
      }
      if (verdict.decision === "ask") {
        const approved = opts.onAsk ? await opts.onAsk({ toolName: name, args, reason: verdict.reason }) : false;
        if (approved) {
          return { name, args, readOnly: tool.readOnly, decision: "allow", needsDispatch: true, content: "", effect: "reset" };
        }
        return { ...base, decision: "deny", content: `Permission denied by the user for ${name}. Do not retry; choose another approach.`, effect: "increment" };
      }
      return { ...base, decision: "deny", content: `Permission denied: ${verdict.reason}. Do not retry this; choose a safe alternative.`, effect: "increment" };
    };

    const applyEffect = (e: DenialEffect): void => {
      if (e === "reset") consecutiveDenials = 0;
      else if (e === "increment") consecutiveDenials++;
    };

    if (toolCalls.length === 1) {
      // Fast path: identical to the original sequential behavior (no Promise.all overhead).
      const r = await resolveOne(toolCalls[0]);
      applyEffect(r.effect);
      if (r.needsDispatch) r.content = await opts.registry.dispatch(r.name, r.args, opts.ctx);
      record({ role: "tool", content: r.content, tool_name: r.name });
      emit({ type: "tool_result", tool: r.name, decision: r.decision, content: r.content, turn });
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
        record({ role: "tool", content: r.content, tool_name: r.name });
        emit({ type: "tool_result", tool: r.name, decision: r.decision, content: r.content, turn });
      }
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
    case "integer":
      return typeof val === "number";
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
