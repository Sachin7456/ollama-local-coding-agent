// Auto-tests: Ollama client request-building + response-parsing + transport.
// Zero deps. The transport tests use a LOCAL stdlib `node:http` mock server —
// NO real model is ever called, so this is safe + instant.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildChatRequest,
  parseChatResponse,
  OllamaClient,
} from "../src/model/ollamaClient.ts";

// ---- helper: spin up a one-off mock Ollama server ----
function mockServer(
  handler: (body: any, req: http.IncomingMessage) => { status?: number; json?: unknown; text?: string },
): Promise<{ url: string; close: () => Promise<void>; lastBody: () => any; lastUrl: () => string }> {
  let lastBody: any = null;
  let lastUrl = "";
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastUrl = req.url ?? "";
      lastBody = data ? JSON.parse(data) : null;
      const out = handler(lastBody, req);
      res.statusCode = out.status ?? 200;
      if (out.text !== undefined) {
        res.end(out.text);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        lastBody: () => lastBody,
        lastUrl: () => lastUrl,
      });
    });
  });
}

// ---------- pure: buildChatRequest ----------
test("buildChatRequest pins num_ctx, disables streaming, omits empty tools", () => {
  const body = buildChatRequest({
    model: "qwen2.5-coder:7b",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(body.stream, false);
  assert.equal(body.model, "qwen2.5-coder:7b");
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.keep_alive, "5m");
  assert.ok(body.options.temperature <= 0.3);
  assert.equal(body.tools, undefined);
});

test("buildChatRequest includes tools + honors num_ctx override + model switch", () => {
  const body = buildChatRequest({
    model: "qwen3-coder:30b",
    messages: [{ role: "user", content: "x" }],
    numCtxOverride: 4096,
    tools: [
      { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
    ],
  });
  assert.equal(body.model, "qwen3-coder:30b");
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(body.tools?.length, 1);
  assert.equal(body.tools?.[0].function.name, "read_file");
});

// ---------- pure: parseChatResponse ----------
test("parseChatResponse extracts text, object tool args, and usage", () => {
  const r = parseChatResponse({
    message: {
      role: "assistant",
      content: "hello",
      tool_calls: [{ function: { name: "grep", arguments: { pattern: "foo" } } }],
    },
    prompt_eval_count: 10,
    eval_count: 5,
  });
  assert.equal(r.text, "hello");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "grep");
  assert.deepEqual(r.toolCalls[0].function.arguments, { pattern: "foo" });
  assert.deepEqual(r.usage, { promptTokens: 10, evalTokens: 5, totalTokens: 15 });
});

test("parseChatResponse tolerates string-encoded tool arguments + missing fields", () => {
  const r = parseChatResponse({
    message: { content: "", tool_calls: [{ function: { name: "x", arguments: '{"a":1}' } }] },
  });
  assert.deepEqual(r.toolCalls[0].function.arguments, { a: 1 });
  assert.equal(r.usage.totalTokens, 0);
  assert.equal(r.text, "");
});

test("parseChatResponse captures non-function-wrapped tool calls (weak-model shapes)", () => {
  const r = parseChatResponse({
    message: { content: "", tool_calls: [{ name: "read_file", arguments: { path: "x" } }] },
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "read_file");
  assert.deepEqual(r.toolCalls[0].function.arguments, { path: "x" });
});

test("parseChatResponse handles {tool, params} and DROPS nameless entries", () => {
  const r = parseChatResponse({
    message: { content: "", tool_calls: [{ tool: "grep", params: { pattern: "y" } }, { function: {} }] },
  });
  assert.equal(r.toolCalls.length, 1); // the nameless {function:{}} is filtered out (re-enables content recovery)
  assert.equal(r.toolCalls[0].function.name, "grep");
  assert.deepEqual(r.toolCalls[0].function.arguments, { pattern: "y" });
});

// ---------- transport: OllamaClient against a mock server ----------
test("OllamaClient.chat sends correct body to /api/chat and parses the reply", async () => {
  const srv = await mockServer(() => ({
    json: {
      message: { role: "assistant", content: "pong", tool_calls: [] },
      prompt_eval_count: 3,
      eval_count: 2,
      done: true,
    },
  }));
  try {
    const client = new OllamaClient(srv.url);
    const result = await client.chat({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(srv.lastUrl(), "/api/chat");
    assert.equal(srv.lastBody().model, "qwen2.5-coder:7b");
    assert.equal(srv.lastBody().stream, false);
    assert.equal(srv.lastBody().options.num_ctx, 8192);
    assert.equal(result.text, "pong");
    assert.equal(result.usage.totalTokens, 5);
  } finally {
    await srv.close();
  }
});

test("OllamaClient.listModels parses /api/tags", async () => {
  const srv = await mockServer(() => ({
    json: { models: [{ name: "qwen2.5-coder:7b" }, { name: "qwen3-coder:30b" }] },
  }));
  try {
    const client = new OllamaClient(srv.url);
    const models = await client.listModels();
    assert.deepEqual(models, ["qwen2.5-coder:7b", "qwen3-coder:30b"]);
  } finally {
    await srv.close();
  }
});

test("OllamaClient.chat throws a clear error on non-2xx", async () => {
  const srv = await mockServer(() => ({ status: 500, text: "boom" }));
  try {
    const client = new OllamaClient(srv.url);
    await assert.rejects(
      () => client.chat({ messages: [{ role: "user", content: "x" }] }),
      /failed: 500/,
    );
  } finally {
    await srv.close();
  }
});

test("OllamaClient trims a trailing slash in the base url", async () => {
  const srv = await mockServer(() => ({ json: { message: { content: "ok" } } }));
  try {
    const client = new OllamaClient(srv.url + "/");
    const r = await client.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.text, "ok");
    assert.equal(srv.lastUrl(), "/api/chat"); // not //api/chat
  } finally {
    await srv.close();
  }
});
