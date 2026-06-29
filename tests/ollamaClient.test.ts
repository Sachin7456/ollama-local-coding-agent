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
  shouldRetry,
  backoffDelayMs,
} from "../src/model/ollamaClient.ts";

/** Tiny delays + no jitter so retry tests run instantly + deterministically. */
const FAST = { retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 } };

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
    const client = new OllamaClient(srv.url, { retry: { maxRetries: 0 } }); // no retry → assert the message fast
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

// ---------- retry / backoff (transient-failure resilience) ----------
test("shouldRetry: 408/429/5xx + network codes + TimeoutError yes; 4xx/AbortError/unknown no", () => {
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 500 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 429 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 408 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 404 })), false);
  assert.equal(shouldRetry(Object.assign(new Error("x"), { status: 400 })), false);
  // Node fetch wraps a network failure in a TypeError with the real code under .cause
  assert.equal(shouldRetry(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(shouldRetry(new TypeError("fetch failed")), true); // message fallback
  assert.equal(shouldRetry(Object.assign(new Error("stalled"), { name: "TimeoutError" })), true);
  assert.equal(shouldRetry(Object.assign(new Error("cancelled"), { name: "AbortError" })), false);
  assert.equal(shouldRetry(new Error("something unexpected")), false); // conservative default
});

test("backoffDelayMs grows exponentially and caps (jitter 0 -> exact)", () => {
  const cfg = { maxRetries: 5, initialDelayMs: 100, maxDelayMs: 500, factor: 2, jitterRatio: 0 };
  assert.equal(backoffDelayMs(0, cfg), 100);
  assert.equal(backoffDelayMs(1, cfg), 200);
  assert.equal(backoffDelayMs(2, cfg), 400);
  assert.equal(backoffDelayMs(3, cfg), 500); // capped at maxDelayMs
});

test("chat retries a 500 then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer(() => (++calls < 3 ? { status: 500, text: "boom" } : { json: { message: { content: "ok" } } }));
  try {
    const r = await new OllamaClient(srv.url, FAST).chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.text, "ok");
    assert.equal(calls, 3); // 2 failures + 1 success
  } finally {
    await srv.close();
  }
});

test("chat retries a 429 then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer(() => (++calls < 2 ? { status: 429, text: "slow down" } : { json: { message: { content: "ok" } } }));
  try {
    const r = await new OllamaClient(srv.url, FAST).chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.text, "ok");
    assert.equal(calls, 2);
  } finally {
    await srv.close();
  }
});

test("chat gives up after maxRetries on a persistent 500", async () => {
  let calls = 0;
  const srv = await mockServer(() => {
    calls++;
    return { status: 500, text: "boom" };
  });
  try {
    const client = new OllamaClient(srv.url, { retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 } });
    await assert.rejects(() => client.chat({ messages: [{ role: "user", content: "x" }] }), /failed: 500/);
    assert.equal(calls, 3); // initial + 2 retries
  } finally {
    await srv.close();
  }
});

test("chat does NOT retry a 404 (fails fast)", async () => {
  let calls = 0;
  const srv = await mockServer(() => {
    calls++;
    return { status: 404, text: "nope" };
  });
  try {
    await assert.rejects(() => new OllamaClient(srv.url, FAST).chat({ messages: [{ role: "user", content: "x" }] }), /failed: 404/);
    assert.equal(calls, 1); // no retry on a client error
  } finally {
    await srv.close();
  }
});

test("chat does NOT retry (or even attempt) on a pre-aborted user signal", async () => {
  let calls = 0;
  const srv = await mockServer(() => {
    calls++;
    return { json: { message: { content: "ok" } } };
  });
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => new OllamaClient(srv.url, FAST).chat({ messages: [{ role: "user", content: "x" }], signal: ac.signal }));
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("chat retries a network error (connection refused) then gives up", async () => {
  // grab a port, then close it -> connecting yields ECONNREFUSED (a retryable network error)
  const tmp = http.createServer();
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
  const { port } = tmp.address() as AddressInfo;
  await new Promise<void>((r) => tmp.close(() => r()));
  const client = new OllamaClient(`http://127.0.0.1:${port}`, { retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 } });
  await assert.rejects(() => client.chat({ messages: [{ role: "user", content: "x" }] }));
});

test("an abort during backoff cancels the retry immediately (no extra attempt)", async () => {
  let calls = 0;
  const srv = await mockServer(() => {
    calls++;
    return { status: 500, text: "boom" }; // always retryable
  });
  try {
    const client = new OllamaClient(srv.url, { retry: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 1000, factor: 1, jitterRatio: 0 } });
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 30); // abort while the ~1000ms backoff after attempt #1 is pending
    await assert.rejects(() => client.chat({ messages: [{ role: "user", content: "x" }], signal: ac.signal }));
    assert.ok(Date.now() - started < 800, "aborted well before the 1000ms backoff elapsed");
    assert.equal(calls, 1); // the backoff was cancelled before a 2nd attempt
  } finally {
    await srv.close();
  }
});

test("listModels retries a transient failure then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer(() => (++calls < 2 ? { status: 503, text: "warming up" } : { json: { models: [{ name: "qwen2.5-coder:7b" }] } }));
  try {
    const models = await new OllamaClient(srv.url, FAST).listModels();
    assert.deepEqual(models, ["qwen2.5-coder:7b"]);
    assert.equal(calls, 2);
  } finally {
    await srv.close();
  }
});

test("chatStream retries the connect (500 then stream) WITHOUT double-emitting deltas", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    if (calls < 2) {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.setHeader("content-type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "Hel" }, done: false }) + "\n");
    res.write(JSON.stringify({ message: { content: "lo" }, done: false }) + "\n");
    res.write(JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const deltas: string[] = [];
    const res = await new OllamaClient(`http://127.0.0.1:${port}`, FAST).chatStream(
      { messages: [{ role: "user", content: "x" }] },
      (c) => deltas.push(c),
    );
    assert.equal(calls, 2); // connect retried once
    assert.deepEqual(deltas, ["Hel", "lo"]); // each delta exactly once (retry did not replay them)
    assert.equal(res.text, "Hello");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("chatStream does NOT retry a mid-stream drop (error propagates, no replay)", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "Hi" }, done: false }) + "\n"); // flush headers + 1st delta
    // Drop AFTER the client has the headers (fetch() resolved) so the failure lands in reader.read() — the
    // post-connect phase that is intentionally NOT retried — rather than in the retry-wrapped fetch.
    setTimeout(() => req.socket.destroy(), 60);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const deltas: string[] = [];
    await assert.rejects(() =>
      new OllamaClient(`http://127.0.0.1:${port}`, FAST).chatStream({ messages: [{ role: "user", content: "x" }] }, (c) => deltas.push(c)),
    );
    assert.equal(calls, 1); // mid-stream failure is NOT retried
    assert.ok(deltas.length <= 1); // no duplicated deltas
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("timeoutMs aborts a stalled request with a retryable TimeoutError", async () => {
  let calls = 0;
  const server = http.createServer(() => {
    calls++; // accept the request but never respond -> the per-request timeout must fire
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const client = new OllamaClient(`http://127.0.0.1:${port}`, { retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 } });
    await assert.rejects(() => client.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 40 }));
    assert.equal(calls, 2); // timed out, retried once (timeout is retryable), then gave up
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
