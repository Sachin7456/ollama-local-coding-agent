// Auto-tests: the list_models tool. Zero deps; a stub client (no real Ollama).

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeListModelsTool } from "../src/model/listModelsTool.ts";
import type { OllamaClient } from "../src/model/ollamaClient.ts";
import type { ToolContext } from "../src/tools/tools.ts";

function stubClient(listModels: () => Promise<string[]>): OllamaClient {
  return { listModels } as unknown as OllamaClient;
}
const ctx: ToolContext = { cwd: "." };

test("list_models is a read-only tool with the right name + empty object schema", () => {
  const t = makeListModelsTool(stubClient(async () => []));
  assert.equal(t.name, "list_models");
  assert.equal(t.readOnly, true);
  assert.equal((t.parameters as { type?: string }).type, "object");
});

test("list_models lists installed models with a count", async () => {
  const t = makeListModelsTool(stubClient(async () => ["qwen2.5-coder:7b", "qwen3-coder:30b"]));
  const out = await t.execute({}, ctx);
  assert.match(out, /Installed Ollama models \(2\)/);
  assert.match(out, /- qwen2\.5-coder:7b/);
  assert.match(out, /- qwen3-coder:30b/);
});

test("list_models reports when none are installed", async () => {
  const t = makeListModelsTool(stubClient(async () => []));
  const out = await t.execute({}, ctx);
  assert.match(out, /No models are installed/);
});

test("list_models returns an error string on failure (never throws)", async () => {
  const t = makeListModelsTool(
    stubClient(async () => {
      throw new Error("connection refused");
    }),
  );
  const out = await t.execute({}, ctx);
  assert.match(out, /Error listing Ollama models: connection refused/);
});
