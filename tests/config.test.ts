// Auto-tests: config loading + model switching.
// Zero deps — uses Node's built-in test runner (node:test) + assert.
// Run (after asking the user): npm run test:m0
//   == node --experimental-strip-types --test tests/config.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel,
  loadConfig,
  DEFAULT_MODEL,
  MODELS,
  OLLAMA_BASE_URL,
} from "../src/model/config.ts";

test("default model is qwen2.5-coder:7b (the lighter model)", () => {
  assert.equal(DEFAULT_MODEL, "qwen2.5-coder:7b");
  assert.equal(resolveModel().name, "qwen2.5-coder:7b");
});

test("model switching resolves the requested model + its settings", () => {
  const m = resolveModel("qwen3-coder:30b");
  assert.equal(m.name, "qwen3-coder:30b");
  assert.equal(m.role, "orchestrator");
  assert.equal(m.numCtx, 32768);
});

test("HARNESS_MODEL env var overrides the default", () => {
  const prev = process.env.HARNESS_MODEL;
  process.env.HARNESS_MODEL = "qwen3-coder:30b";
  try {
    assert.equal(resolveModel().name, "qwen3-coder:30b");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_MODEL;
    else process.env.HARNESS_MODEL = prev;
  }
});

test("explicit arg beats the env var", () => {
  const prev = process.env.HARNESS_MODEL;
  process.env.HARNESS_MODEL = "qwen3-coder:30b";
  try {
    assert.equal(resolveModel("qwen2.5-coder:7b").name, "qwen2.5-coder:7b");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_MODEL;
    else process.env.HARNESS_MODEL = prev;
  }
});

test("unknown model throws loudly (typos fail fast)", () => {
  assert.throws(() => resolveModel("not-a-real-model"), /Unknown model/);
});

test("every model pins num_ctx, keep_alive, and low temperature", () => {
  for (const [tag, cfg] of Object.entries(MODELS)) {
    assert.ok(cfg.numCtx > 0, `${tag} must pin numCtx`);
    assert.ok(cfg.keepAlive.length > 0, `${tag} must set keepAlive`);
    assert.ok(
      cfg.sampling.temperature <= 0.3,
      `${tag} should use low temperature for reliable tool use`,
    );
  }
});

test("loadConfig wires base url + active model", () => {
  const c = loadConfig("qwen3-coder:30b");
  assert.equal(c.activeModel, "qwen3-coder:30b");
  assert.equal(c.ollamaBaseUrl, OLLAMA_BASE_URL);
  assert.ok(c.ollamaBaseUrl.startsWith("http"));
  assert.ok(Object.keys(c.models).length >= 2);
});
