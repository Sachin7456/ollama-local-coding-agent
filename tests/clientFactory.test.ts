// Auto-tests: the provider client factory (increment 1 — Ollama only; compat routing lands in increment 2).
// Zero deps; no network (we only assert which client type is built + that it memoizes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, resetClientCache } from "../src/model/clientFactory.ts";
import { OllamaClient } from "../src/model/ollamaClient.ts";

test("clientFor returns an OllamaClient and memoizes per provider+baseUrl", () => {
  resetClientCache();
  const a = clientFor("qwen2.5-coder:7b");
  const b = clientFor("qwen3-coder:30b"); // both = provider ollama + default baseUrl → same cached instance
  assert.ok(a instanceof OllamaClient);
  assert.equal(a, b);
});

test("clientFor falls back to an Ollama client for an unknown/legacy tag", () => {
  resetClientCache();
  const c = clientFor("totally-unknown-model");
  assert.ok(c instanceof OllamaClient);
});

test("resetClientCache forces a fresh client", () => {
  resetClientCache();
  const a = clientFor("qwen2.5-coder:7b");
  resetClientCache();
  const b = clientFor("qwen2.5-coder:7b");
  assert.notEqual(a, b); // cache cleared → new instance
});
