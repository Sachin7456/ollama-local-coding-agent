// Tests the one-time startup preflight check. Zero deps; fetch is injected so no
// real Ollama server is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, formatPreflight } from "../src/cli/preflight.ts";

function fakeFetch(models: string[]): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ models: models.map((name) => ({ name })) }),
  })) as unknown as typeof fetch;
}
const unreachableFetch: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

const GOOD_NODE = "v22.14.0";

test("passes when Ollama is reachable and all required models are present", async () => {
  const r = await preflight(
    { baseUrl: "http://x", requiredModels: ["qwen2.5-coder:7b"] },
    fakeFetch(["qwen2.5-coder:7b", "qwen3-coder:30b"]),
    GOOD_NODE,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(formatPreflight(r), "");
});

test("flags a missing model with an 'ollama pull' hint", async () => {
  const r = await preflight(
    { baseUrl: "http://x", requiredModels: ["qwen2.5-coder:7b", "qwen3-coder:30b"] },
    fakeFetch(["qwen2.5-coder:7b"]),
    GOOD_NODE,
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /ollama pull qwen3-coder:30b/);
});

test("flags an unreachable Ollama with install + serve guidance", async () => {
  const r = await preflight(
    { baseUrl: "http://127.0.0.1:11434", requiredModels: ["qwen2.5-coder:7b"] },
    unreachableFetch,
    GOOD_NODE,
  );
  assert.equal(r.ok, false);
  const text = r.problems.join("\n");
  assert.match(text, /not reachable/);
  assert.match(text, /ollama serve/);
  assert.match(text, /ollama\.com\/download/);
});

test("flags an old Node version", async () => {
  const r = await preflight(
    { baseUrl: "http://x", requiredModels: ["qwen2.5-coder:7b"] },
    fakeFetch(["qwen2.5-coder:7b"]),
    "v18.0.0",
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /Node\.js 22\.6\+/);
});

test("formatPreflight renders problems for the CLI", () => {
  const text = formatPreflight({ ok: false, problems: ["thing A", "thing B"] });
  assert.match(text, /can't start/);
  assert.match(text, /thing A/);
  assert.match(text, /thing B/);
});
