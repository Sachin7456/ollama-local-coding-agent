// CompatClient — talks to any provider that exposes the standard /v1/chat/completions API (Groq, Cerebras,
// OpenRouter, vLLM, llama.cpp, LM Studio, ...). Implements the SAME ModelClient surface as OllamaClient, so the
// agent loop / orchestrator are provider-agnostic. Zero-dep (global fetch + JSON), shares retry.ts.
//
// MVP: non-streaming. chatStream() does ONE non-stream call and emits the whole text once — tools still work
// because a non-stream response returns COMPLETE tool_calls (no delta assembly). Real token-level SSE + tool-call
// delta assembly is a follow-up (design in research/23). The conversation history is provider-neutral
// (ChatMessage), so a /model switch between this and Ollama mid-session keeps progress.

import { randomUUID } from "node:crypto";
import { resolveModel } from "./config.ts";
import { type RetryConfig, RETRY_DEFAULTS, retryWithBackoff } from "./retry.ts";
import type { ModelClient } from "./modelClient.ts";
import type { ChatMessage, ChatOptions, ChatResult, ToolCall } from "./ollamaClient.ts";

/** Map our neutral ChatMessage to the /v1 wire shape (assistant tool_calls + tool tool_call_id are required). */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments ?? {}) },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
  }
  return { role: m.role, content: m.content };
}

/** Parse one /v1 tool_call entry (arguments arrive as a JSON STRING). null if it has no usable name. */
function fromWireToolCall(tc: unknown): ToolCall | null {
  const o = (tc ?? {}) as Record<string, unknown>;
  const fn = (o.function ?? {}) as Record<string, unknown>;
  const name = typeof fn.name === "string" && fn.name.trim() ? fn.name : "";
  if (!name) return null;
  let args: Record<string, unknown> = {};
  const rawArgs = fn.arguments;
  if (typeof rawArgs === "string") {
    try {
      const v = JSON.parse(rawArgs);
      if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
    } catch {
      /* leave {} — arg repair lives in the agent loop */
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  const id = typeof o.id === "string" && o.id ? o.id : randomUUID();
  return { id, function: { name, arguments: args } };
}

/** Parse a /v1 non-streaming chat response into our typed ChatResult. Pure → unit-testable. */
export function parseCompatResponse(json: unknown): ChatResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const choice = (Array.isArray(j.choices) ? j.choices[0] : {}) as Record<string, unknown>;
  const msg = (choice?.message ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.map(fromWireToolCall).filter((c): c is ToolCall => c !== null);
  const usage = (j.usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const evalTokens = Number(usage.completion_tokens ?? 0);
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: { promptTokens, evalTokens, totalTokens: promptTokens + evalTokens },
    raw: json,
  };
}

export class CompatClient implements ModelClient {
  private baseUrl: string;
  private apiKeyEnv?: string;
  private retry: RetryConfig;

  constructor(baseUrl: string, apiKeyEnv?: string, opts?: { retry?: Partial<RetryConfig> }) {
    this.baseUrl = baseUrl.replace(/\/+$/, ""); // baseUrl already ends in /v1 → we append /chat/completions
    this.apiKeyEnv = apiKeyEnv;
    this.retry = { ...RETRY_DEFAULTS, ...(opts?.retry ?? {}) };
  }

  /** Bearer header from the named env var. Throws a CLEAR error (before any request) if the key is missing. */
  private authHeader(): Record<string, string> {
    if (!this.apiKeyEnv) return {};
    const key = process.env[this.apiKeyEnv];
    if (!key) throw new Error(`Missing API key: set ${this.apiKeyEnv} (in .env) for ${this.baseUrl}.`);
    return { authorization: `Bearer ${key}` };
  }

  /** Per-attempt signal: the user signal, optionally combined with a fresh per-request timeout. */
  private attemptSignal(opts: ChatOptions): AbortSignal | undefined {
    if (!opts.timeoutMs || opts.timeoutMs <= 0) return opts.signal;
    const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs)].filter(Boolean) as AbortSignal[];
    return AbortSignal.any(signals);
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const cfg = resolveModel(opts.model);
    const headers = { "content-type": "application/json", ...this.authHeader() }; // throws early if key missing
    const body: Record<string, unknown> = {
      model: cfg.name,
      messages: opts.messages.map(toWireMessage),
      stream: false,
      temperature: cfg.sampling.temperature,
      top_p: cfg.sampling.top_p,
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools; // our ToolDef already matches the /v1 shape
    return retryWithBackoff(
      async () => {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: this.attemptSignal(opts),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const where = this.apiKeyEnv ? ` (check ${this.apiKeyEnv})` : "";
          const msg =
            res.status === 401 || res.status === 403
              ? `compat auth failed: ${res.status}${where}. ${detail}`.trim()
              : `compat /chat/completions failed: ${res.status} ${res.statusText} ${detail}`.trim();
          throw Object.assign(new Error(msg), { status: res.status });
        }
        return parseCompatResponse(await res.json());
      },
      opts.signal,
      this.retry,
    );
  }

  async chatStream(opts: ChatOptions, onDelta: (chunk: string) => void): Promise<ChatResult> {
    // MVP: one non-streaming call, emit the whole text once. (Real SSE token streaming = follow-up.)
    const result = await this.chat(opts);
    if (result.text) onDelta(result.text);
    return result;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const headers = this.authHeader();
    return retryWithBackoff(
      async () => {
        const res = await fetch(`${this.baseUrl}/models`, { headers, signal });
        if (!res.ok) throw Object.assign(new Error(`compat /models failed: ${res.status}`), { status: res.status });
        const json = (await res.json()) as { data?: Array<{ id?: string }> };
        return Array.isArray(json.data) ? json.data.map((m) => m.id ?? "").filter((s) => s.length > 0) : [];
      },
      signal,
      this.retry,
    );
  }
}
