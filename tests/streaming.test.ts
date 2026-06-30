// Auto-tests: token streaming (NDJSON). Zero deps; local mock server, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { runAgent } from "../src/agent/agent.ts";
import { createDefaultRegistry } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";

function ndjsonServer(lines: () => string[]) {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/x-ndjson");
      for (const l of lines()) res.write(l + "\n");
      res.end();
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new OllamaClient(`http://127.0.0.1:${port}`),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const J = (o: unknown) => JSON.stringify(o);

test("chatStream accumulates content deltas, tool_calls, and usage", async () => {
  const srv = await ndjsonServer(() => [
    J({ message: { role: "assistant", content: "Hel" }, done: false }),
    J({ message: { role: "assistant", content: "lo" }, done: false }),
    J({
      message: { role: "assistant", content: "", tool_calls: [{ function: { name: "grep", arguments: { pattern: "x" } } }] },
      done: false,
    }),
    J({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 4, eval_count: 2 }),
  ]);
  try {
    const deltas: string[] = [];
    const res = await srv.client.chatStream(
      { model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }] },
      (c) => deltas.push(c),
    );
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(res.text, "Hello");
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].function.name, "grep");
    assert.equal(res.usage.totalTokens, 6);
  } finally {
    await srv.close();
  }
});

test("chatStream concatenates content across multiple chunks", async () => {
  const srv = await ndjsonServer(() => [
    J({ message: { content: "AB" }, done: false }),
    J({ message: { content: "CD" }, done: false }),
    J({ done: true, prompt_eval_count: 1, eval_count: 1 }),
  ]);
  try {
    const res = await srv.client.chatStream({ messages: [{ role: "user", content: "x" }] }, () => {});
    assert.equal(res.text, "ABCD");
  } finally {
    await srv.close();
  }
});

test("chatStream throws on non-2xx", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const client = new OllamaClient(`http://127.0.0.1:${port}`, { retry: { maxRetries: 0 } }); // no retry → fast assert
  try {
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: "user", content: "x" }] }, () => {}),
      /stream\) failed: 500/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("runAgent with stream:true streams tokens and completes", async () => {
  const srv = await ndjsonServer(() => [
    J({ message: { content: "Done." }, done: false }),
    J({ done: true, prompt_eval_count: 2, eval_count: 1 }),
  ]);
  try {
    const tokens: string[] = [];
    const res = await runAgent({
      client: srv.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: "." },
      userMessage: "say done",
      model: "qwen2.5-coder:7b",
      stream: true,
      onToken: (c) => tokens.push(c),
    });
    assert.equal(res.stopReason, "completed");
    assert.equal(res.text, "Done.");
    assert.equal(tokens.join(""), "Done.");
  } finally {
    await srv.close();
  }
});

// ---------- A7: streaming timeout is an IDLE/STALL guard, not a total deadline ----------
function delayedNdjson(chunks: Array<{ text: string; afterMs: number }>) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    let i = 0;
    const writeNext = (): void => {
      if (i >= chunks.length) {
        res.end();
        return;
      }
      const c = chunks[i++];
      setTimeout(() => {
        res.write(c.text + "\n");
        writeNext();
      }, c.afterMs);
    };
    req.on("data", () => {});
    req.on("end", writeNext);
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new OllamaClient(`http://127.0.0.1:${port}`, { retry: { maxRetries: 0 } }),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("A7: a slow-but-steady stream completes under a small idle timeout (not a total deadline)", async () => {
  const srv = await delayedNdjson([
    { text: J({ message: { content: "A" }, done: false }), afterMs: 25 },
    { text: J({ message: { content: "B" }, done: false }), afterMs: 25 },
    { text: J({ message: { content: "C" }, done: false }), afterMs: 25 },
    { text: J({ message: { content: "D" }, done: false }), afterMs: 25 },
    { text: J({ message: { content: "E" }, done: false }), afterMs: 25 },
    { text: J({ done: true, prompt_eval_count: 1, eval_count: 1 }), afterMs: 25 },
  ]);
  try {
    // total ~150ms exceeds timeoutMs:120, but each inter-chunk gap (~25ms) is well under it → kick() keeps it alive.
    // Wide per-gap margin (95ms) so scheduling jitter under full-suite load can't trip the idle watchdog.
    const res = await srv.client.chatStream(
      { model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "x" }], timeoutMs: 120 },
      () => {},
    );
    assert.equal(res.text, "ABCDE");
  } finally {
    await srv.close();
  }
});

test("A7: a stalled stream aborts with a TimeoutError", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    req.on("data", () => {});
    req.on("end", () => {
      res.write(J({ message: { content: "A" }, done: false }) + "\n"); // one chunk, then never end → idle stall
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const client = new OllamaClient(`http://127.0.0.1:${port}`, { retry: { maxRetries: 0 } });
  try {
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: "user", content: "x" }], timeoutMs: 50 }, () => {}),
      (e: unknown) => (e as Error)?.name === "TimeoutError" || /idle/.test(String((e as Error)?.message)),
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
