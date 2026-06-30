// Tests the model-source toggle: "builtin" (fast default) vs "file" (user-editable),
// plus safe fallback to built-in when the file is missing/invalid. Zero deps.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModels, resolveModel, resolveWorkerModel, fileRegistryModels, MODELS, DEFAULT_MODEL_SOURCE, AGENTIC_SAMPLING } from "../src/model/config.ts";
import { buildChatRequest } from "../src/model/ollamaClient.ts";
import { loadDotEnv } from "../src/cli/loadEnv.ts";

const S = { temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.05 };

function clearModelEnv(): void {
  delete process.env.QWEN_HARNESS_MODEL_SOURCE;
  delete process.env.QWEN_HARNESS_MODELS_FILE;
  delete process.env.HARNESS_MODEL;
}
// Clear BEFORE each test too: a developer's local .env (auto-loaded when loadEnv.ts is imported)
// must not leak in and flip the default model source to "file".
beforeEach(clearModelEnv);
afterEach(clearModelEnv);

function writeModelsFile(models: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qh-models-")), "models.json");
  fs.writeFileSync(file, JSON.stringify(models));
  return file;
}

test("default toggle is 'builtin' and uses the in-memory table (no file I/O)", () => {
  assert.equal(DEFAULT_MODEL_SOURCE, "builtin");
  assert.equal(getModels(), MODELS); // same object — the fast path
  assert.equal(resolveModel().name, "qwen2.5-coder:7b");
});

test("file source loads model definitions from a JSON file", () => {
  const file = writeModelsFile({
    models: {
      "my-model:1": { name: "my-model:1", role: "general", numCtx: 4096, keepAlive: "5m", sampling: { temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.05 }, approxSizeGB: 3 },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;

  const models = getModels();
  assert.ok(models["my-model:1"], "file-defined model should be present");
  assert.equal(resolveModel("my-model:1").numCtx, 4096);
  // default falls back to the first key when the built-in default isn't in the file
  assert.equal(resolveModel().name, "my-model:1");
});

test("A3: a file model with NO sampling block loads with agentic defaults (no first-turn crash)", () => {
  const file = writeModelsFile({
    models: { "nosamp:1": { name: "nosamp:1", role: "general", numCtx: 4096, keepAlive: "5m", approxSizeGB: 3 } },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.deepEqual(getModels()["nosamp:1"].sampling, AGENTIC_SAMPLING);
  // the Ollama request builder dereferences sampling.* — it must not throw now
  assert.equal(buildChatRequest({ model: "nosamp:1", messages: [] }).options.temperature, AGENTIC_SAMPLING.temperature);
});

test("A3: a partial sampling block fills only the missing fields", () => {
  const file = writeModelsFile({
    models: { "part:1": { name: "part:1", role: "general", numCtx: 4096, keepAlive: "5m", approxSizeGB: 3, sampling: { temperature: 0.7 } } },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  const s = getModels()["part:1"].sampling;
  assert.equal(s.temperature, 0.7); // kept
  assert.equal(s.top_p, AGENTIC_SAMPLING.top_p); // filled
  assert.equal(s.top_k, AGENTIC_SAMPLING.top_k);
  assert.equal(s.repeat_penalty, AGENTIC_SAMPLING.repeat_penalty);
});

test("A3: a full sampling block is preserved unchanged", () => {
  const full = { temperature: 0.33, top_p: 0.5, top_k: 11, repeat_penalty: 1.2 };
  const file = writeModelsFile({
    models: { "full:1": { name: "full:1", role: "general", numCtx: 4096, keepAlive: "5m", approxSizeGB: 3, sampling: full } },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.deepEqual(getModels()["full:1"].sampling, full);
});

test("file source also accepts a bare registry (no 'models' wrapper)", () => {
  const file = writeModelsFile({
    "bare:1": { name: "bare:1", role: "worker", numCtx: 8192, keepAlive: "5m", sampling: { temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.05 }, approxSizeGB: 4 },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.ok(getModels()["bare:1"]);
});

test("missing file falls back to built-in models (never breaks)", () => {
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = path.join(os.tmpdir(), "definitely-not-here-12345.json");
  assert.equal(getModels(), MODELS);
  assert.equal(resolveModel().name, "qwen2.5-coder:7b");
});

test("invalid file content falls back to built-in models", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qh-models-"));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, "{ not valid json");
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.equal(getModels(), MODELS);
});

test("unknown model still throws loudly", () => {
  assert.throws(() => resolveModel("nope:404"), /Unknown model/);
});

// ---------------- resolveWorkerModel (model-agnostic, registry-driven worker) ----------------
test("resolveWorkerModel: builtin → the smallest model (qwen2.5-coder:7b)", () => {
  assert.equal(resolveWorkerModel().name, "qwen2.5-coder:7b");
});

test("resolveWorkerModel: file registry → picks the SMALLEST model; honors a valid request", () => {
  const file = writeModelsFile({
    models: {
      "big:1": { name: "big:1", role: "orchestrator", numCtx: 32768, keepAlive: "5m", sampling: S, approxSizeGB: 20 },
      "small:1": { name: "small:1", role: "worker", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 3 },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.equal(resolveWorkerModel().name, "small:1");
  assert.equal(resolveWorkerModel("big:1").name, "big:1"); // explicit override honored
});

test("resolveWorkerModel: single-model (e.g. DeepSeek-only) registry returns that model", () => {
  const file = writeModelsFile({
    models: {
      "deepseek-coder:6.7b": { name: "deepseek-coder:6.7b", role: "general", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 4 },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.equal(resolveWorkerModel().name, "deepseek-coder:6.7b");
});

test("resolveWorkerModel: no approxSizeGB → falls back to a role:worker model", () => {
  const file = writeModelsFile({
    models: {
      "a:1": { name: "a:1", role: "general", numCtx: 8192, keepAlive: "5m", sampling: S },
      "w:1": { name: "w:1", role: "worker", numCtx: 8192, keepAlive: "5m", sampling: S },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.equal(resolveWorkerModel().name, "w:1");
});

test("resolveWorkerModel: prefers a role:\"worker\" model even if a 'general' one is smaller", () => {
  const file = writeModelsFile({
    models: {
      "tiny:1": { name: "tiny:1", role: "general", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 2 },
      "work:1": { name: "work:1", role: "worker", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 5 },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.equal(resolveWorkerModel().name, "work:1"); // role:worker beats a smaller general model
});

// ---------------- fileRegistryModels (startup validation input) ----------------
test("fileRegistryModels: [] for builtin source, the file's tags when source=file", () => {
  assert.deepEqual(fileRegistryModels(), []); // builtin (default) → nothing to warn about
  const file = writeModelsFile({
    models: {
      "m1:1": { name: "m1:1", role: "general", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 3 },
      "m2:1": { name: "m2:1", role: "worker", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 4 },
    },
  });
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  assert.deepEqual(fileRegistryModels().sort(), ["m1:1", "m2:1"]);
});

// ---------------- regression: I-009 (an empty .env value broke file source) ----------------
// Fully generic — a temp dir + an arbitrary model tag (no hardcoded path or model), so it holds
// for ANY user, on any machine, with no real Ollama model needed.
test("regression I-009: an EMPTY QWEN_HARNESS_MODELS_FILE in .env still loads the file registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qh-i009-"));
  const tag = "any-user-model:latest"; // not Qwen — proves it isn't model-specific
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({ models: { [tag]: { name: tag, role: "general", numCtx: 8192, keepAlive: "5m", sampling: S, approxSizeGB: 5 } } }),
  );
  // A .env exactly like one copied from .env.example: file source ON, but MODELS_FILE left EMPTY.
  fs.writeFileSync(path.join(dir, ".env"), `QWEN_HARNESS_MODEL_SOURCE=file\nQWEN_HARNESS_MODELS_FILE=\nHARNESS_MODEL=${tag}\n`);

  const prevCwd = process.cwd();
  try {
    process.chdir(dir); // so the default "./models.json" resolves inside the temp dir
    loadDotEnv(path.join(dir, ".env"));
    // the empty value must be SKIPPED (the fix) — otherwise the path resolved to the directory
    assert.equal(process.env.QWEN_HARNESS_MODELS_FILE, undefined);
    assert.equal(getModels()[tag]?.name, tag); // file registry loaded (no "could not read <dir>")
    assert.equal(resolveModel().name, tag); // resolves the user's model — no "Unknown model" crash
  } finally {
    process.chdir(prevCwd);
  }
});
