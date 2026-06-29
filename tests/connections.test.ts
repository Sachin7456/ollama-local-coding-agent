// Auto-tests: named connections (multi-account provider routing). Zero deps; a temp models.json as the file
// source per test (fresh dir → no config-cache collisions). No network — we only assert routing + client type.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRouting, resolveConnection, OLLAMA_BASE_URL } from "../src/model/config.ts";
import { clientFor, resetClientCache } from "../src/model/clientFactory.ts";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { CompatClient } from "../src/model/compatClient.ts";

/** Run fn with a temp models.json as the file source, then restore env + caches. Pass a string for RAW JSON
 *  (e.g. to exercise duplicate keys, which a JS object can't represent). */
function withFile(json: unknown, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qh-conn-"));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json), "utf8");
  const prevSrc = process.env.QWEN_HARNESS_MODEL_SOURCE;
  const prevFile = process.env.QWEN_HARNESS_MODELS_FILE;
  process.env.QWEN_HARNESS_MODEL_SOURCE = "file";
  process.env.QWEN_HARNESS_MODELS_FILE = file;
  resetClientCache();
  try {
    fn();
  } finally {
    if (prevSrc === undefined) delete process.env.QWEN_HARNESS_MODEL_SOURCE;
    else process.env.QWEN_HARNESS_MODEL_SOURCE = prevSrc;
    if (prevFile === undefined) delete process.env.QWEN_HARNESS_MODELS_FILE;
    else process.env.QWEN_HARNESS_MODELS_FILE = prevFile;
    resetClientCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal valid model entry (name/numCtx/keepAlive are what the registry validator requires). */
const M = (extra: Record<string, unknown>) => ({ name: "x", numCtx: 8192, keepAlive: "5m", ...extra });

test("builtin model routes to the default local (ollama) connection", () => {
  const r = resolveRouting("qwen2.5-coder:7b");
  assert.equal(r.type, "ollama");
  assert.equal(r.baseUrl, OLLAMA_BASE_URL);
  assert.equal(r.apiKeyEnv, undefined);
});

test("resolveConnection defaults to local and throws on an unknown name", () => {
  assert.equal(resolveConnection().type, "ollama");
  assert.throws(() => resolveConnection("nope"), /Unknown connection/);
});

test("same API + different accounts = different keys via named connections", () => {
  withFile(
    {
      connections: {
        "groq-personal": { type: "compat", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K_PERSONAL" },
        "groq-work": { type: "compat", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K_WORK" },
        local2: { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      models: {
        "m-personal": M({ connection: "groq-personal" }),
        "m-work": M({ connection: "groq-work" }),
        "m-local": M({ connection: "local2" }),
      },
    },
    () => {
      const p = resolveRouting("m-personal");
      const w = resolveRouting("m-work");
      assert.equal(p.apiKeyEnv, "K_PERSONAL");
      assert.equal(w.apiKeyEnv, "K_WORK");
      assert.equal(p.baseUrl, w.baseUrl); // same endpoint
      assert.notEqual(p.apiKeyEnv, w.apiKeyEnv); // different accounts
      assert.ok(clientFor("m-local") instanceof OllamaClient); // an ollama connection still works
    },
  );
});

test("a compat connection builds a CompatClient (memoized per apiKeyEnv)", () => {
  withFile(
    {
      connections: {
        "groq-a": { type: "compat", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K_A" },
        "groq-b": { type: "compat", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K_B" },
      },
      models: { a: M({ connection: "groq-a" }), b: M({ connection: "groq-b" }) },
    },
    () => {
      const a = clientFor("a");
      const b = clientFor("b");
      assert.ok(a instanceof CompatClient);
      assert.notEqual(a, b); // same baseUrl, different apiKeyEnv → separate clients (multi-account)
    },
  );
});

test("inline override beats the named connection", () => {
  withFile(
    {
      connections: { groq: { type: "compat", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K" } },
      models: { m: M({ connection: "groq", provider: "ollama", baseUrl: "http://127.0.0.1:11434" }) },
    },
    () => {
      assert.equal(resolveRouting("m").type, "ollama"); // inline wins over the compat connection
    },
  );
});

test("a model naming an unknown connection throws via resolveRouting", () => {
  withFile({ models: { m: M({ connection: "does-not-exist" }) } }, () => {
    assert.throws(() => resolveRouting("m"), /Unknown connection/);
  });
});

test("a file with only models (no connections block) → models route to local", () => {
  withFile({ models: { m: M({}) } }, () => {
    const r = resolveRouting("m");
    assert.equal(r.type, "ollama");
    assert.equal(r.baseUrl, OLLAMA_BASE_URL);
  });
});

test("an invalid connections block falls back to local (no crash); no-connection models still resolve", () => {
  withFile({ connections: { bad: { type: "compat" } }, models: { m: M({}) } }, () => {
    assert.equal(resolveRouting("m").type, "ollama"); // invalid block dropped → local still works
    assert.throws(() => resolveConnection("bad"), /Unknown connection/); // the invalid entry was discarded
  });
});

test("duplicate connection name → LAST wins (JSON.parse semantics)", () => {
  // raw JSON with a duplicate key — a JS object literal can't express this
  const raw =
    '{"connections":{"dup":{"type":"ollama","baseUrl":"http://first"},' +
    '"dup":{"type":"ollama","baseUrl":"http://last"}},' +
    '"models":{"m":{"name":"x","numCtx":8192,"keepAlive":"5m","connection":"dup"}}}';
  withFile(raw, () => {
    assert.equal(resolveRouting("m").baseUrl, "http://last");
  });
});
