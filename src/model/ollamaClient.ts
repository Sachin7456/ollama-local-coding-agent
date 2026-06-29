// Ollama client — the single integration point with the model server.
//
// Zero deps: uses the built-in global `fetch`. Talks to Ollama's NATIVE
// /api/chat endpoint (preferred
// because it lets us pin num_ctx per request, returns tool-call arguments as a
// real object, and always reports token usage).
//
// This is the ONLY place that knows the wire format. The rest of the harness
// (agent loop, tools, orchestrator) depends on the small typed surface below, so the
// model is swappable just by changing config.

import { randomUUID } from "node:crypto";
import { resolveModel, OLLAMA_BASE_URL, type ModelConfig } from "../model/config.ts";
import { type RetryConfig, RETRY_DEFAULTS, retryWithBackoff } from "./retry.ts";
import type { ModelClient } from "./modelClient.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool call emitted by the model. Native Ollama gives `arguments` as an object. `id` links a call to its
 *  result message (`ChatMessage.tool_call_id`) — generated for Ollama (no native id), provider-supplied for /v1. */
export interface ToolCall {
  id: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** present on assistant turns that call tools */
  tool_calls?: ToolCall[];
  /** present on role:"tool" result messages — which tool produced this */
  tool_name?: string;
  /** present on role:"tool" result messages — the id of the tool_call this result answers (required by /v1). */
  tool_call_id?: string;
}

/** A tool definition as Ollama expects it under `tools` (standard function-calling schema). */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface Usage {
  promptTokens: number;
  evalTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
}

export interface ChatOptions {
  /** Model tag; defaults via resolveModel (HARNESS_MODEL / default 7b). */
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Override the model's configured num_ctx for this one call. */
  numCtxOverride?: number;
  signal?: AbortSignal;
  /**
   * Optional per-request timeout (ms). OFF by default — local generation can legitimately take minutes, so we
   * never kill it unless a caller opts in. When set, a stalled request aborts with a TimeoutError (retryable),
   * while a user Ctrl+C stays an AbortError (not retried). A fresh timeout is started for each retry attempt.
   */
  timeoutMs?: number;
}

interface OllamaChatBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: ToolDef[];
  keep_alive: string;
  options: {
    num_ctx: number;
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
  };
}

/** Build the exact JSON body sent to /api/chat. Pure function → easy to unit-test. */
export function buildChatRequest(opts: ChatOptions): OllamaChatBody {
  const m: ModelConfig = resolveModel(opts.model);
  const body: OllamaChatBody = {
    model: m.name,
    messages: opts.messages,
    stream: false,
    keep_alive: m.keepAlive,
    options: {
      // ALWAYS pin num_ctx — Ollama's default silently truncates.
      num_ctx: opts.numCtxOverride ?? m.numCtx,
      temperature: m.sampling.temperature,
      top_p: m.sampling.top_p,
      top_k: m.sampling.top_k,
      repeat_penalty: m.sampling.repeat_penalty,
    },
  };
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  return body;
}

function safeJsonObject(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Normalize ONE wire tool-call entry to our ToolCall, or null if it has no usable name.
 * Accepts the standard `{function:{name,arguments}}` AND the non-wrapped variants weak models
 * emit (`{name|tool, arguments|parameters|params|args|input}`). Returning null for a nameless
 * entry lets the agent's content-recovery still fire instead of being shadowed by an empty call.
 */
export function normalizeWireToolCall(tc: unknown): ToolCall | null {
  const o = (tc ?? {}) as Record<string, unknown>;
  const fn = (o.function ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === "string" && v.trim() ? v : "");
  const name = pick(fn.name) || pick(o.name) || pick(o.tool);
  if (!name) return null;
  const rawArgs =
    fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? o.arguments ?? o.parameters ?? o.params ?? o.args ?? o.input;
  const args =
    typeof rawArgs === "string"
      ? safeJsonObject(rawArgs)
      : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
  const id = pick(o.id) || randomUUID(); // Ollama emits no id → generate one so the result can link back
  return { id, function: { name, arguments: args } };
}

/** Parse a native /api/chat response into our typed ChatResult. Pure function. */
export function parseChatResponse(json: unknown): ChatResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const msg = (j.message ?? {}) as Record<string, unknown>;

  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls
    .map(normalizeWireToolCall)
    .filter((c): c is ToolCall => c !== null);

  const promptTokens = Number(j.prompt_eval_count ?? 0);
  const evalTokens = Number(j.eval_count ?? 0);

  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: { promptTokens, evalTokens, totalTokens: promptTokens + evalTokens },
    raw: json,
  };
}

// Retry/backoff helpers now live in ./retry.ts (shared by all provider clients). Re-exported here so existing
// importers and tests keep their import path stable.
export { RETRY_DEFAULTS, shouldRetry, backoffDelayMs } from "./retry.ts";
export type { RetryConfig } from "./retry.ts";

export class OllamaClient implements ModelClient {
  private baseUrl: string;
  private retry: RetryConfig;

  constructor(baseUrl: string = OLLAMA_BASE_URL, opts?: { retry?: Partial<RetryConfig> }) {
    // strip a trailing slash so `${baseUrl}/api/chat` is always well-formed
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.retry = { ...RETRY_DEFAULTS, ...(opts?.retry ?? {}) };
  }

  /** The AbortSignal for ONE attempt: the user signal, optionally combined with a FRESH per-attempt timeout. */
  private _attemptSignal(opts: ChatOptions): AbortSignal | undefined {
    if (!opts.timeoutMs || opts.timeoutMs <= 0) return opts.signal;
    const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs)].filter(Boolean) as AbortSignal[];
    return AbortSignal.any(signals);
  }

  /** One non-streaming chat turn. Retries transient failures; throws on non-2xx (4xx) / user abort. */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body = buildChatRequest(opts);
    return retryWithBackoff(async () => {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this._attemptSignal(opts),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw Object.assign(
          new Error(`Ollama /api/chat failed: ${res.status} ${res.statusText} ${detail}`.trim()),
          { status: res.status },
        );
      }
      const json: unknown = await res.json();
      return parseChatResponse(json);
    }, opts.signal, this.retry);
  }

  /**
   * Streaming chat: reads Ollama's NDJSON stream, calls onDelta(textChunk) for
   * each incremental content piece, and returns the assembled ChatResult.
   */
  async chatStream(opts: ChatOptions, onDelta: (chunk: string) => void): Promise<ChatResult> {
    const body = { ...buildChatRequest(opts), stream: true };
    // Retry ONLY the connect (fetch + res.ok). The stream is read OUTSIDE the retry: mid-stream reader.read()
    // errors are NOT retried — stream-start is the retryable part, mid-body failures are rare, and retrying would
    // RE-EMIT already-delivered onDelta chunks. (A fresh per-attempt timeout, if set, resets on each retry.)
    const res = await retryWithBackoff(async () => {
      const r = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this._attemptSignal(opts),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw Object.assign(
          new Error(`Ollama /api/chat (stream) failed: ${r.status} ${r.statusText} ${detail}`.trim()),
          { status: r.status },
        );
      }
      return r;
    }, opts.signal, this.retry);
    if (!res.body) throw new Error("Ollama returned no response body for streaming.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls: ToolCall[] = [];
    let promptTokens = 0;
    let evalTokens = 0;
    let lastRaw: unknown = null;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // ignore partial/garbage lines
      }
      lastRaw = obj;
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg) {
        if (typeof msg.content === "string" && msg.content.length > 0) {
          text += msg.content;
          onDelta(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const c = normalizeWireToolCall(tc);
            if (c) toolCalls.push(c);
          }
        }
      }
      if (typeof obj.prompt_eval_count === "number") promptTokens = obj.prompt_eval_count;
      if (typeof obj.eval_count === "number") evalTokens = obj.eval_count;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer); // any trailing line without newline

    return {
      text,
      toolCalls,
      usage: { promptTokens, evalTokens, totalTokens: promptTokens + evalTokens },
      raw: lastRaw,
    };
  }

  /** Liveness/inventory check via GET /api/tags. Retries transient failures. Returns model tags. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    return retryWithBackoff(async () => {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
      if (!res.ok) throw Object.assign(new Error(`Ollama /api/tags failed: ${res.status}`), { status: res.status });
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      return Array.isArray(json.models)
        ? json.models.map((m) => m.name ?? "").filter((n) => n.length > 0)
        : [];
    }, signal, this.retry);
  }
}
