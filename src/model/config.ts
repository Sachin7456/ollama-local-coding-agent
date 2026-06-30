// Model registry + switching for the Qwen local-LLM harness.
//
// Zero dependencies — pure TypeScript, runs on Node via native type-stripping.
// The single source of truth for "which model + what settings".
// The client, tools and agent loop all read from here, so switching
// models is a one-line/one-env-var change.
//
// Holds the per-model config table and the config-precedence rules.
//
// Model definitions come from one of two sources, controlled by a toggle:
//   - "builtin" (default): the in-memory table below — zero file I/O, no latency.
//   - "file": a JSON file, so users with different models don't have to edit code.

import fs from "node:fs";
import path from "node:path";

/** Sampling tuned for agentic/tool use. Low temperature => stable tool calls. */
export interface SamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
}

export interface ModelConfig {
  /** Ollama model tag, e.g. "qwen2.5-coder:7b". */
  name: string;
  /** Suggested role for multi-agent routing and logging. */
  role: "orchestrator" | "worker" | "general";
  /**
   * Context window to PIN per request. Ollama's default is small and unreliable
   * (it silently truncates), so we always pin it explicitly.
   */
  numCtx: number;
  /** How long Ollama keeps the model resident in memory, e.g. "5m". */
  keepAlive: string;
  /** Sampling params for this model. */
  sampling: SamplingParams;
  /** Rough on-disk size (GB) for capacity and concurrency planning. */
  approxSizeGB: number;
  // ---- optional provider routing (default = local Ollama; omit = ollama, fully backward-compatible) ----
  /** Name of a `connections` entry this model uses (e.g. "groq-work"). Default: the `local` (Ollama) connection. */
  connection?: string;
  /** Inline override (instead of `connection`): which client. "ollama" | "compat" (the standard
   *  /v1/chat/completions API — Groq, Cerebras, OpenRouter, vLLM, llama.cpp, LM Studio, ...). */
  provider?: "ollama" | "compat";
  /** Inline override: base URL for this model's endpoint (ends in /v1 for compat). Defaults to OLLAMA_BASE_URL. */
  baseUrl?: string;
  /** Inline override: env var holding the API key (e.g. "GROQ_API_KEY"). Local Ollama needs none. */
  apiKeyEnv?: string;
}

/** A named connection to a model endpoint + account. Models reference one by name (`ModelConfig.connection`).
 *  Defining the SAME API type under several names (different `apiKeyEnv`) lets one harness use multiple accounts. */
export interface Connection {
  /** "ollama" (local, native /api/chat) | "compat" (the standard /v1/chat/completions API). */
  type: "ollama" | "compat";
  baseUrl: string;
  /** Env var holding the API key (e.g. "GROQ_PERSONAL"). Local Ollama needs none. */
  apiKeyEnv?: string;
}

export interface HarnessConfig {
  /** Base URL of the local Ollama server. */
  ollamaBaseUrl: string;
  /** The active model tag. */
  activeModel: string;
  /** All known models, keyed by tag. */
  models: Record<string, ModelConfig>;
}

export const AGENTIC_SAMPLING: SamplingParams = {
  temperature: 0.1,
  top_p: 0.9,
  top_k: 20,
  repeat_penalty: 1.1,
};

/**
 * Per-model defaults. The two models the user has installed locally.
 * qwen2.5-coder:7b is the DEFAULT (lighter — kinder to the machine).
 */
export const MODELS: Record<string, ModelConfig> = {
  "qwen2.5-coder:7b": {
    name: "qwen2.5-coder:7b",
    role: "worker",
    numCtx: 8192,
    keepAlive: "5m",
    sampling: { ...AGENTIC_SAMPLING },
    approxSizeGB: 4.7,
  },
  "qwen3-coder:30b": {
    name: "qwen3-coder:30b",
    role: "orchestrator",
    numCtx: 32768,
    keepAlive: "5m",
    sampling: { ...AGENTIC_SAMPLING },
    approxSizeGB: 18,
  },
};

/** The default model — the lighter 7B, per the user's "connect 7b first" choice. */
export const DEFAULT_MODEL = "qwen2.5-coder:7b";

/** Ollama server URL. Override with OLLAMA_BASE_URL. 127.0.0.1 (not localhost) to avoid IPv6 surprises. */
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

/** The connection a model uses when it names none. */
export const DEFAULT_CONNECTION = "local";

/** Builtin named connections. `local` points at the Ollama server; users add more via the file source. */
export const CONNECTIONS: Record<string, Connection> = {
  local: { type: "ollama", baseUrl: OLLAMA_BASE_URL },
};

// ---- model source toggle: "builtin" (fast default) vs "file" (user-editable) ----

export type ModelSource = "builtin" | "file";

/**
 * THE TOGGLE. We ship "builtin" so our own runs read the in-memory table with zero
 * file I/O (no latency). Users can set QWEN_HARNESS_MODEL_SOURCE=file (or change
 * this default) to load model definitions from a JSON file instead.
 */
export const DEFAULT_MODEL_SOURCE: ModelSource = "builtin";

function modelSource(): ModelSource {
  const s = process.env.QWEN_HARNESS_MODEL_SOURCE;
  return s === "file" || s === "builtin" ? s : DEFAULT_MODEL_SOURCE;
}

/** Path to the user model file (when source === "file"). Default ./models.json. */
function modelsFilePath(): string {
  return process.env.QWEN_HARNESS_MODELS_FILE ?? "models.json";
}

const fileModelCache = new Map<string, Record<string, ModelConfig>>();

function isValidModelRegistry(v: unknown): v is Record<string, ModelConfig> {
  if (!v || typeof v !== "object") return false;
  const entries = Object.values(v as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every((e) => {
    const m = e as Partial<ModelConfig>;
    return Boolean(m) && typeof m.name === "string" && typeof m.numCtx === "number" && typeof m.keepAlive === "string";
  });
}


function withSamplingDefaults(m: ModelConfig): ModelConfig {
  const s = (m.sampling ?? {}) as Partial<SamplingParams>;
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    ...m,
    sampling: {
      temperature: num(s.temperature, AGENTIC_SAMPLING.temperature),
      top_p: num(s.top_p, AGENTIC_SAMPLING.top_p),
      top_k: num(s.top_k, AGENTIC_SAMPLING.top_k),
      repeat_penalty: num(s.repeat_penalty, AGENTIC_SAMPLING.repeat_penalty),
    },
  };
}

function normalizeRegistry(raw: Record<string, ModelConfig>): Record<string, ModelConfig> {
  const out: Record<string, ModelConfig> = {};
  for (const [tag, m] of Object.entries(raw)) out[tag] = withSamplingDefaults(m);
  return out;
}

/**
 * The active model registry. "builtin" returns the in-memory table directly (no
 * I/O — the fast path). "file" reads + caches the JSON file; on ANY problem it
 * falls back to the built-in table with a warning, so the harness never just breaks.
 */
export function getModels(): Record<string, ModelConfig> {
  if (modelSource() === "builtin") return MODELS;
  const file = path.resolve(modelsFilePath());
  const cached = fileModelCache.get(file);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const raw = (parsed as { models?: unknown }).models ?? parsed;
    if (isValidModelRegistry(raw)) {
      const normalized = normalizeRegistry(raw); // A3: fill any missing sampling block so the clients never crash
      fileModelCache.set(file, normalized);
      return normalized;
    }
    console.error(`[config] ${file} is not a valid model registry — using built-in models.`);
  } catch {
    console.error(`[config] could not read ${file} — using built-in models.`);
  }
  return MODELS;
}

/** The default model tag for a given registry. */
function defaultModelFor(models: Record<string, ModelConfig>): string {
  return models[DEFAULT_MODEL] ? DEFAULT_MODEL : Object.keys(models)[0];
}

/**
 * Resolve the active model config.
 * Precedence: explicit arg > HARNESS_MODEL env var > the registry's default.
 * Throws on an unknown model so typos fail loudly instead of silently.
 */
export function resolveModel(requested?: string): ModelConfig {
  const models = getModels();
  const tag = requested ?? process.env.HARNESS_MODEL ?? defaultModelFor(models);
  const cfg = models[tag];
  if (!cfg) {
    const known = Object.keys(models).join(", ");
    throw new Error(
      `Unknown model "${tag}". Known models: ${known}.\n` +
        `  • To use your own model: pull it in Ollama, add it to models.json, and set ` +
        `QWEN_HARNESS_MODEL_SOURCE=file (copy models.example.json to start).`,
    );
  }
  return cfg;
}

/**
 * Resolve the WORKER model for multi-agent mode — REGISTRY-DRIVEN, so it works with ANY
 * installed models (not a hardcoded tag). Precedence: explicit `requested` (if it's a valid tag) >
 * the SMALLEST model the user marked `role:"worker"` (so role assignments are honored) > the
 * smallest model overall > the registry default. Always returns a model from the active registry.
 */
export function resolveWorkerModel(requested?: string): ModelConfig {
  const models = getModels();
  if (requested && models[requested]) return models[requested];
  const all = Object.values(models);
  // Prefer models the user explicitly marked role:"worker"; if none, fall back to all models.
  const workers = all.filter((m) => m.role === "worker");
  const pool = workers.length > 0 ? workers : all;
  const sized = pool.filter((m) => typeof m.approxSizeGB === "number");
  if (sized.length > 0) {
    return sized.reduce((smallest, m) => (m.approxSizeGB < smallest.approxSizeGB ? m : smallest));
  }
  return pool[0] ?? models[defaultModelFor(models)];
}

/**
 * The resolved model TAG (registry key) — same precedence as resolveModel, but returns the KEY, not the config.
 * Needed because a tag and the model's `name` differ for compat models (e.g. tag "gpt-oss-120b" vs a
 * provider-prefixed wire name); routing/compaction/clientFor all key by TAG, so the active model must be a tag.
 */
export function resolveModelTag(requested?: string): string {
  const models = getModels();
  const tag = requested ?? process.env.HARNESS_MODEL ?? defaultModelFor(models);
  return models[tag] ? tag : defaultModelFor(models);
}

/** The worker model TAG for multi-agent mode — mirrors resolveWorkerModel() but returns the registry key. */
export function resolveWorkerModelTag(requested?: string): string {
  const models = getModels();
  if (requested && models[requested]) return requested;
  const cfg = resolveWorkerModel(requested);
  const tag =
    Object.keys(models).find((k) => models[k] === cfg) ?? Object.keys(models).find((k) => models[k].name === cfg.name);
  return tag ?? defaultModelFor(models);
}

/**
 * When the model source is "file", the model tags declared in that file (else []).
 * Used at startup to warn about models a user listed but hasn't pulled.
 */
export function fileRegistryModels(): string[] {
  return modelSource() === "file" ? Object.keys(getModels()) : [];
}

// ---- named connections (provider / account routing) ----

const fileConnCache = new Map<string, Record<string, Connection>>();

function isValidConnections(v: unknown): v is Record<string, Connection> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every((e) => {
    const c = e as Partial<Connection>;
    return Boolean(c) && (c.type === "ollama" || c.type === "compat") && typeof c.baseUrl === "string";
  });
}

/** Guarantee a `local` (Ollama) connection so models without one always resolve. */
function withLocal(conns: Record<string, Connection>): Record<string, Connection> {
  return conns.local ? conns : { local: { type: "ollama", baseUrl: OLLAMA_BASE_URL }, ...conns };
}

/**
 * The active connection registry. "builtin" → in-memory CONNECTIONS. "file" → the file's `connections` block
 * (cached); a missing block is fine (just `local`), an invalid one warns + falls back to `local`. A duplicate
 * connection name in the file resolves to the LAST (standard JSON.parse behavior).
 */
export function getConnections(): Record<string, Connection> {
  if (modelSource() === "builtin") return withLocal(CONNECTIONS);
  const file = path.resolve(modelsFilePath());
  const cached = fileConnCache.get(file);
  if (cached) return cached;
  let result = withLocal(CONNECTIONS);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { connections?: unknown };
    if (parsed.connections === undefined) {
      result = withLocal(CONNECTIONS); // file declares only models → just the local connection
    } else if (isValidConnections(parsed.connections)) {
      result = withLocal(parsed.connections);
    } else {
      console.error(`[config] ${file} has an invalid "connections" block — using only the local connection.`);
    }
  } catch {
    /* unreadable file → just local (getModels already warns about the file) */
  }
  fileConnCache.set(file, result);
  return result;
}

/** Resolve a connection by name (default `local`). Throws on an unknown name so typos fail loudly. */
export function resolveConnection(name?: string): Connection {
  const conns = getConnections();
  const key = name ?? DEFAULT_CONNECTION;
  const conn = conns[key];
  if (!conn) throw new Error(`Unknown connection "${key}". Known: ${Object.keys(conns).join(", ")}.`);
  return conn;
}

/** Effective endpoint routing for a model tag: inline override > its `connection` > the default `local`. */
export function resolveRouting(tag: string): { type: "ollama" | "compat"; baseUrl: string; apiKeyEnv?: string } {
  const cfg = getModels()[tag];
  if (cfg?.provider || cfg?.baseUrl) {
    return { type: cfg.provider ?? "ollama", baseUrl: cfg.baseUrl ?? OLLAMA_BASE_URL, apiKeyEnv: cfg.apiKeyEnv };
  }
  const conn = resolveConnection(cfg?.connection);
  return { type: conn.type, baseUrl: conn.baseUrl, apiKeyEnv: conn.apiKeyEnv };
}

/** Build the full harness config, with an optional model override. */
export function loadConfig(modelOverride?: string): HarnessConfig {
  const models = getModels();
  const active = resolveModel(modelOverride);
  return {
    ollamaBaseUrl: OLLAMA_BASE_URL,
    activeModel: active.name,
    models,
  };
}
