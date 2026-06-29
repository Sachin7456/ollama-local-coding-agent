// The provider-agnostic seam. Every model client (OllamaClient today, a /v1-compatible client next) implements
// this SAME surface, so the agent loop / orchestrator never need to know which provider is active. Switching a
// model — even cloud <-> local mid-session — is just swapping the client behind this interface; the conversation
// history is provider-neutral and travels unchanged.
//
// Types stay defined in ollamaClient.ts (their current home) and are imported type-only here — under
// `--experimental-strip-types` these imports are erased, so there is no runtime import cycle.

import type { ChatOptions, ChatResult } from "./ollamaClient.ts";

export interface ModelClient {
  /** One non-streaming turn. */
  chat(opts: ChatOptions): Promise<ChatResult>;
  /** Streaming turn: onDelta(chunk) per incremental content piece; returns the assembled result. */
  chatStream(opts: ChatOptions, onDelta: (chunk: string) => void): Promise<ChatResult>;
  /** Installed/available model tags (for /models + preflight). */
  listModels(signal?: AbortSignal): Promise<string[]>;
}
