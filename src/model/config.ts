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
}

export interface HarnessConfig {
  /** Base URL of the local Ollama server. */
  ollamaBaseUrl: string;
  /** The active model tag. */
  activeModel: string;
  /** All known models, keyed by tag. */
  models: Record<string, ModelConfig>;
}

const AGENTIC_SAMPLING: SamplingParams = {
  temperature: 0.1,
  top_p: 0.9,
  top_k: 20,
  repeat_penalty: 1.05,
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
      fileModelCache.set(file, raw);
      return raw;
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
    throw new Error(`Unknown model "${tag}". Known models: ${known}`);
  }
  return cfg;
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
