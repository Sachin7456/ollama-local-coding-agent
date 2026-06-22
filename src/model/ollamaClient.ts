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

import { resolveModel, OLLAMA_BASE_URL, type ModelConfig } from "../model/config.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool call emitted by the model. Native Ollama gives `arguments` as an object. */
export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** present on assistant turns that call tools */
  tool_calls?: ToolCall[];
  /** present on role:"tool" result messages — which tool produced this */
  tool_name?: string;
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

/** Parse a native /api/chat response into our typed ChatResult. Pure function. */
export function parseChatResponse(json: unknown): ChatResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const msg = (j.message ?? {}) as Record<string, unknown>;

  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.map((tc): ToolCall => {
    const fn = ((tc as Record<string, unknown>)?.function ?? {}) as Record<string, unknown>;
    const args = fn.arguments;
    return {
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments:
          typeof args === "string"
            ? safeJsonObject(args) // some builds / the /v1 path encode as a string
            : (args && typeof args === "object" ? (args as Record<string, unknown>) : {}),
      },
    };
  });

  const promptTokens = Number(j.prompt_eval_count ?? 0);
  const evalTokens = Number(j.eval_count ?? 0);

  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: { promptTokens, evalTokens, totalTokens: promptTokens + evalTokens },
    raw: json,
  };
}

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl: string = OLLAMA_BASE_URL) {
    // strip a trailing slash so `${baseUrl}/api/chat` is always well-formed
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** One non-streaming chat turn. Throws on transport / non-2xx errors. */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body = buildChatRequest(opts);
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Ollama /api/chat failed: ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
    const json: unknown = await res.json();
    return parseChatResponse(json);
  }

  /**
   * Streaming chat: reads Ollama's NDJSON stream, calls onDelta(textChunk) for
   * each incremental content piece, and returns the assembled ChatResult.
   */
  async chatStream(opts: ChatOptions, onDelta: (chunk: string) => void): Promise<ChatResult> {
    const body = { ...buildChatRequest(opts), stream: true };
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat (stream) failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
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
            const fn = ((tc as Record<string, unknown>)?.function ?? {}) as Record<string, unknown>;
            const args = fn.arguments;
            toolCalls.push({
              function: {
                name: typeof fn.name === "string" ? fn.name : "",
                arguments:
                  typeof args === "string"
                    ? safeJsonObject(args)
                    : args && typeof args === "object" && !Array.isArray(args)
                      ? (args as Record<string, unknown>)
                      : {},
              },
            });
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

  /** Liveness/inventory check via GET /api/tags. Returns model tags. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`);
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return Array.isArray(json.models)
      ? json.models.map((m) => m.name ?? "").filter((n) => n.length > 0)
      : [];
  }
}
