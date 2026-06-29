// Auto-tests: CompatClient (/v1/chat/completions). Zero deps; a local node:http mock /v1 server — no real API,
// no key, instant + safe.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CompatClient, parseCompatResponse } from "../src/model/compatClient.ts";

// Make these tests independent of any local .env / models.json: force the BUILTIN registry so resolveModel()
// always finds MODEL, regardless of the developer's file-source config. (No real API / key — all mocked.)
let prevSource: string | undefined;
before(() => {
  prevSource = process.env.QWEN_HARNESS_MODEL_SOURCE;
  process.env.QWEN_HARNESS_MODEL_SOURCE = "builtin";
});
after(() => {
  if (prevSource === undefined) delete process.env.QWEN_HARNESS_MODEL_SOURCE;
  else process.env.QWEN_HARNESS_MODEL_SOURCE = prevSource;
});

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
      if (out.text !== undefined) res.end(out.text);
      else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`, // baseUrl ends in /v1; the client appends /chat/completions
        close: () => new Promise<void>((r) => server.close(() => r())),
        lastBody: () => lastBody,
        lastUrl: () => lastUrl,
      });
    });
  });
}

const FAST = { retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 } };
const MODEL = "qwen2.5-coder:7b"; // a builtin tag so resolveModel() works (its .name is sent as the wire model)

test("parseCompatResponse: text + tool_calls (string args -> object, id kept) + usage", () => {
  const r = parseCompatResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "hi",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "grep", arguments: '{"pattern":"x"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(r.text, "hi");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].id, "call_1");
  assert.equal(r.toolCalls[0].function.name, "grep");
  assert.deepEqual(r.toolCalls[0].function.arguments, { pattern: "x" });
  assert.equal(r.usage.totalTokens, 15);
});

test("chat() POSTs /v1/chat/completions and parses the reply", async () => {
  const srv = await mockServer(() => ({ json: { choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  try {
    const r = await new CompatClient(srv.url, undefined, FAST).chat({ model: MODEL, messages: [{ role: "user", content: "ping" }] });
    assert.equal(srv.lastUrl(), "/v1/chat/completions");
    assert.equal(srv.lastBody().stream, false);
    assert.equal(typeof srv.lastBody().model, "string");
    assert.equal(r.text, "pong");
  } finally {
    await srv.close();
  }
});

test("mapOut sends assistant tool_calls[].id + tool tool_call_id + stringified args", async () => {
  const srv = await mockServer(() => ({ json: { choices: [{ message: { content: "ok" } }] } }));
  try {
    await new CompatClient(srv.url, undefined, FAST).chat({
      model: MODEL,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "grep", arguments: { pattern: "y" } } }] },
        { role: "tool", content: "result", tool_name: "grep", tool_call_id: "c1" },
      ],
    });
    const sent = srv.lastBody().messages;
    const asst = sent.find((m: any) => m.role === "assistant");
    assert.equal(asst.tool_calls[0].id, "c1");
    assert.equal(asst.tool_calls[0].type, "function");
    assert.equal(asst.tool_calls[0].function.arguments, JSON.stringify({ pattern: "y" })); // /v1 wants a STRING
    const toolMsg = sent.find((m: any) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "c1");
  } finally {
    await srv.close();
  }
});

test("a missing API key throws a clear error BEFORE any request", async () => {
  delete process.env.NOPE_KEY;
  await assert.rejects(
    () => new CompatClient("http://127.0.0.1:1/v1", "NOPE_KEY", FAST).chat({ model: MODEL, messages: [{ role: "user", content: "x" }] }),
    /Missing API key.*NOPE_KEY/,
  );
});

test("401 -> clear auth error, NOT retried", async () => {
  let calls = 0;
  const srv = await mockServer(() => {
    calls++;
    return { status: 401, text: "bad key" };
  });
  try {
    process.env.T_KEY = "x";
    await assert.rejects(
      () => new CompatClient(srv.url, "T_KEY", FAST).chat({ model: MODEL, messages: [{ role: "user", content: "x" }] }),
      /auth failed.*T_KEY/i,
    );
    assert.equal(calls, 1);
  } finally {
    delete process.env.T_KEY;
    await srv.close();
  }
});

test("5xx -> retried then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer(() => (++calls < 2 ? { status: 503, text: "warming" } : { json: { choices: [{ message: { content: "ok" } }] } }));
  try {
    const r = await new CompatClient(srv.url, undefined, FAST).chat({ model: MODEL, messages: [{ role: "user", content: "x" }] });
    assert.equal(r.text, "ok");
    assert.equal(calls, 2);
  } finally {
    await srv.close();
  }
});

test("chatStream emits the whole text once + returns tool calls (MVP non-stream)", async () => {
  const srv = await mockServer(() => ({
    json: { choices: [{ message: { content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }] } }] },
  }));
  try {
    const deltas: string[] = [];
    const r = await new CompatClient(srv.url, undefined, FAST).chatStream({ model: MODEL, messages: [{ role: "user", content: "x" }] }, (c) => deltas.push(c));
    assert.deepEqual(deltas, ["hello"]);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, "grep");
  } finally {
    await srv.close();
  }
});

test("listModels parses /v1/models data[].id", async () => {
  const srv = await mockServer(() => ({ json: { data: [{ id: "llama-3.3-70b" }, { id: "gpt-oss-120b" }] } }));
  try {
    const models = await new CompatClient(srv.url, undefined, FAST).listModels();
    assert.deepEqual(models, ["llama-3.3-70b", "gpt-oss-120b"]);
  } finally {
    await srv.close();
  }
});
