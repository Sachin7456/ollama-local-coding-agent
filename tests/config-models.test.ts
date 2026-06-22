// Tests the model-source toggle: "builtin" (fast default) vs "file" (user-editable),
// plus safe fallback to built-in when the file is missing/invalid. Zero deps.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModels, resolveModel, resolveWorkerModel, fileRegistryModels, MODELS, DEFAULT_MODEL_SOURCE } from "../src/model/config.ts";

const S = { temperature: 0.1, top_p: 0.9, top_k: 20, repeat_penalty: 1.05 };

afterEach(() => {
  delete process.env.QWEN_HARNESS_MODEL_SOURCE;
  delete process.env.QWEN_HARNESS_MODELS_FILE;
  delete process.env.HARNESS_MODEL;
});

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
