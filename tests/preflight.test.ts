// Tests the one-time startup preflight check. Zero deps; fetch is injected so no
// real Ollama server is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, formatPreflight, checkMemoryHeadroom } from "../src/cli/preflight.ts";

const GB = 1_000_000_000;
test("A2: checkMemoryHeadroom warns only when models likely won't fit", () => {
  const models = { "small:7b": { approxSizeGB: 4.7 }, "big:30b": { approxSizeGB: 18 } };
  // 7b alone (~5.6 GB needed) fits in 16 GB → no warning
  assert.equal(checkMemoryHeadroom(["small:7b"], models, 16 * GB), null);
  // 7b + 30b (~27 GB needed) does NOT fit in 16 GB → warning
  const warn = checkMemoryHeadroom(["small:7b", "big:30b"], models, 16 * GB);
  assert.ok(warn && /GB/.test(warn), "over-budget returns a warning string");
  // unknown sizes → no guess
  assert.equal(checkMemoryHeadroom(["mystery"], {}, 1 * GB), null);
});

test("A9: a single oversized model warns with SINGULAR wording", () => {
  const warn = checkMemoryHeadroom(["big:30b"], { "big:30b": { approxSizeGB: 18 } }, 16 * GB);
  assert.ok(warn && /the selected model needs/.test(warn)); // singular
  assert.doesNotMatch(warn ?? "", /single-agent mode/); // multi-only advice not shown for one model
});

test("A9: multiple oversized models keep the PLURAL wording", () => {
  const models = { "small:7b": { approxSizeGB: 4.7 }, "big:30b": { approxSizeGB: 18 } };
  const warn = checkMemoryHeadroom(["small:7b", "big:30b"], models, 16 * GB);
  assert.ok(warn && /the selected models need/.test(warn)); // plural
  assert.match(warn ?? "", /single-agent mode|fewer models/);
});

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
  const text = formatPreflight({ ok: false, problems: ["thing A", "thing B"], warnings: [] });
  assert.match(text, /can't start/);
  assert.match(text, /thing A/);
  assert.match(text, /thing B/);
});

test("optionalModels: declared-but-not-installed becomes a NON-FATAL warning", async () => {
  const r = await preflight(
    {
      baseUrl: "http://x",
      requiredModels: ["qwen2.5-coder:7b"],
      optionalModels: ["qwen2.5-coder:7b", "deepseek-coder:6.7b"],
    },
    fakeFetch(["qwen2.5-coder:7b"]),
    GOOD_NODE,
  );
  assert.equal(r.ok, true); // warning is non-fatal
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.join("\n"), /deepseek-coder:6\.7b/);
  assert.doesNotMatch(r.warnings.join("\n"), /qwen2\.5-coder:7b/); // required+installed isn't warned
});
