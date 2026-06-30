// Auto-tests: context compaction. Zero deps; mock model server, no real model.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  compactConversation,
  truncateToolResults,
} from "../src/state/compaction.ts";
import { OllamaClient, type ChatMessage } from "../src/model/ollamaClient.ts";
import { runAgent } from "../src/agent/agent.ts";
import { createDefaultRegistry } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";

function mockModel(handler: (body: Record<string, unknown>) => { content?: string; tool_calls?: unknown[]; promptTokens?: number }) {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const r = handler(data ? JSON.parse(data) : {});
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: r.content ?? "", tool_calls: r.tool_calls ?? [] },
          prompt_eval_count: r.promptTokens ?? 1,
          eval_count: 1,
          done: true,
        }),
      );
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ client: new OllamaClient(`http://127.0.0.1:${port}`), close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function isSummaryCall(body: Record<string, unknown>): boolean {
  const msgs = body.messages as Array<{ content?: string }> | undefined;
  return typeof msgs?.[0]?.content === "string" && msgs[0].content.startsWith("You compress");
}

test("estimateTokens / estimateMessagesTokens are roughly chars/4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateMessagesTokens([{ role: "user", content: "abcdabcd" }]) >= 2);
});

test("shouldCompact fires at/above the threshold", () => {
  assert.equal(shouldCompact(6000, 8192, 0.75), false); // 0.75 * 8192 = 6144
  assert.equal(shouldCompact(6144, 8192, 0.75), true);
  assert.equal(shouldCompact(100, 0, 0.75), false);
});

test("compactConversation folds the middle, keeps system + recent tail", async () => {
  const m = await mockModel(() => ({ content: "SUMMARY: goal X, did Y" }));
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];
    const out = await compactConversation({ client: m.client }, messages, { keepRecent: 2 });
    assert.ok(out.summarized >= 4);
    assert.equal(out.messages[0].role, "system");
    assert.match(out.messages[1].content, /Summary of earlier/);
    assert.match(out.messages[1].content, /SUMMARY: goal X/);
    assert.equal(out.messages[out.messages.length - 1].content, "a3");
    assert.ok(out.messages.length < messages.length);
  } finally {
    await m.close();
  }
});

test("compactConversation never starts the tail on an orphan tool message", async () => {
  const m = await mockModel(() => ({ content: "S" }));
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: {} } }] },
      { role: "tool", content: "data", tool_name: "read_file" },
      { role: "assistant", content: "done" },
    ];
    const out = await compactConversation({ client: m.client }, messages, { keepRecent: 2 });
    assert.notEqual(out.messages[2].role, "tool"); // [system, summary, ...tail]
    assert.equal(out.messages[2].content, "done");
  } finally {
    await m.close();
  }
});

test("compactConversation is a no-op when there's no middle to fold", async () => {
  const m = await mockModel(() => ({ content: "S" }));
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
    ];
    const out = await compactConversation({ client: m.client }, messages, { keepRecent: 6 });
    assert.equal(out.summarized, 0);
    assert.equal(out.messages.length, 2);
  } finally {
    await m.close();
  }
});

test("runAgent compacts mid-loop when prompt tokens exceed the threshold", async () => {
  let mainCalls = 0;
  const m = await mockModel((body) => {
    if (isSummaryCall(body)) return { content: "COMPACTED SUMMARY" };
    const idx = mainCalls++;
    if (idx === 0) {
      return { tool_calls: [{ function: { name: "read_file", arguments: { path: "nope" } } }], promptTokens: 100000 };
    }
    return { content: "final answer" };
  });
  try {
    const events: string[] = [];
    const prior: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: "." },
      userMessage: "new question",
      model: "qwen2.5-coder:7b",
      priorMessages: prior,
      compaction: { numCtx: 8192, threshold: 0.75, keepRecent: 3 },
      onEvent: (e) => events.push(e.type),
    });
    assert.ok(events.includes("compaction"), "a compaction event should fire");
    assert.equal(res.stopReason, "completed");
    assert.match(res.text, /final answer/);
    assert.ok(res.messages.some((mm) => mm.content.includes("COMPACTED SUMMARY")));
  } finally {
    await m.close();
  }
});

// ---------------- pair-safe compaction (no orphaned tool_call <-> result) ----------------
/** Assert the compacted list is valid for strict /v1 providers: every tool result has a preceding matching
 *  assistant tool_call, and every assistant tool_call has a following result. */
function assertNoOrphans(messages: ChatMessage[]): void {
  const callAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) callAt.set(c.id, i);
  });
  messages.forEach((m, i) => {
    if (m.role === "tool" && m.tool_call_id) {
      const ci = callAt.get(m.tool_call_id);
      assert.ok(ci !== undefined && ci < i, `orphaned tool result: ${m.tool_call_id}`);
    }
  });
  for (const [id, ci] of callAt) {
    const hasResult = messages.some((m, i) => i > ci && m.role === "tool" && m.tool_call_id === id);
    assert.ok(hasResult, `orphaned tool_call: ${id}`);
  }
}

test("compaction keeps a multi-tool-call assistant + all its results together (no orphan)", async () => {
  const m = await mockModel((b) => (isSummaryCall(b) ? { content: "SUMMARY" } : { content: "x" }));
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", function: { name: "read_file", arguments: {} } },
        { id: "c2", function: { name: "grep", arguments: {} } },
      ] },
      { role: "tool", content: "r1", tool_name: "read_file", tool_call_id: "c1" },
      { role: "tool", content: "r2", tool_name: "grep", tool_call_id: "c2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "done" },
    ];
    const out = await compactConversation({ client: m.client }, messages, { keepRecent: 3 });
    assert.ok(out.summarized > 0);
    assertNoOrphans(out.messages);
  } finally {
    await m.close();
  }
});

test("compaction never splits a NON-adjacent tool_call↔result across the boundary (the fix)", async () => {
  // Synthetic: a non-tool message sits between a tool_call and its result, so the old tool-only guard would NOT
  // catch it — the call would land in the summary and the result in the kept tail = orphan → /v1 400.
  const m = await mockModel((b) => (isSummaryCall(b) ? { content: "SUMMARY" } : { content: "x" }));
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: {} } }] },
      { role: "user", content: "noise between call and result" },
      { role: "tool", content: "r1", tool_name: "read_file", tool_call_id: "c1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const out = await compactConversation({ client: m.client }, messages, { keepRecent: 4 });
    assertNoOrphans(out.messages); // pairSafeTailStart pulls the whole pair into the summary
  } finally {
    await m.close();
  }
});

// ---------------- truncateToolResults (cheap, model-free first step) ----------------
test("truncateToolResults caps oversized tool content and reports savedChars", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "tool", content: "x".repeat(5000), tool_name: "read_file" },
    { role: "assistant", content: "ok" },
    { role: "tool", content: "small", tool_name: "read_file" }, // last tool -> kept verbatim
  ];
  const out = truncateToolResults(msgs, 2000, { keepLast: true });
  assert.ok(out.savedChars > 0);
  assert.match(out.messages[1].content, /\[truncated \d+ chars\]/);
  assert.equal(out.messages[3].content, "small");
  assert.equal(out.messages[0].content, "sys"); // non-tool untouched
});

test("NIT: truncateToolResults is idempotent even at a tiny cap (head reserves marker room)", () => {
  const msgs: ChatMessage[] = [{ role: "tool", content: "y".repeat(5000), tool_name: "read_file" }];
  const pass1 = truncateToolResults(msgs, 100, { keepLast: false });
  assert.ok(pass1.savedChars > 0);
  assert.ok(pass1.messages[0].content.length <= 100); // result fits under the cap (head + marker)
  const pass2 = truncateToolResults(pass1.messages, 100, { keepLast: false });
  assert.equal(pass2.savedChars, 0); // second pass changes nothing
  assert.equal(pass2.messages[0].content, pass1.messages[0].content);
});

test("NIT: truncateToolResults stays idempotent when head >= cap", () => {
  const msgs: ChatMessage[] = [{ role: "tool", content: "z".repeat(5000), tool_name: "read_file" }];
  const pass1 = truncateToolResults(msgs, 2000, { head: 5000, keepLast: false }); // head clamped below cap
  assert.ok(pass1.messages[0].content.length <= 2000);
  const pass2 = truncateToolResults(pass1.messages, 2000, { head: 5000, keepLast: false });
  assert.equal(pass2.savedChars, 0);
});

test("truncateToolResults keeps the most recent tool message verbatim", () => {
  const big2 = "b".repeat(4000);
  const msgs: ChatMessage[] = [
    { role: "tool", content: "a".repeat(4000), tool_name: "read_file" },
    { role: "assistant", content: "x" },
    { role: "tool", content: big2, tool_name: "read_file" }, // last
  ];
  const out = truncateToolResults(msgs, 2000, { keepLast: true });
  assert.match(out.messages[0].content, /\[truncated/);
  assert.equal(out.messages[2].content, big2);
});

test("truncateToolResults leaves small tool and non-tool messages untouched", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "u".repeat(5000) }, // non-tool: never truncated
    { role: "tool", content: "short", tool_name: "grep" },
  ];
  const out = truncateToolResults(msgs, 2000, { keepLast: false });
  assert.equal(out.savedChars, 0);
  assert.equal(out.messages[0].content.length, 5000);
  assert.equal(out.messages[1].content, "short");
});

test("truncateToolResults is idempotent", () => {
  const msgs: ChatMessage[] = [
    { role: "tool", content: "z".repeat(6000), tool_name: "read_file" },
    { role: "assistant", content: "end" },
  ];
  const first = truncateToolResults(msgs, 2000, { keepLast: false });
  assert.ok(first.savedChars > 0);
  const second = truncateToolResults(first.messages, 2000, { keepLast: false });
  assert.equal(second.savedChars, 0); // already short enough
});

test("runAgent truncates large tool results and skips the LLM summary when that suffices", async () => {
  let summaryCalls = 0;
  let mainCalls = 0;
  const m = await mockModel((body) => {
    if (isSummaryCall(body)) {
      summaryCalls++;
      return { content: "SHOULD-NOT-HAPPEN" };
    }
    const idx = mainCalls++;
    if (idx === 0) {
      return { tool_calls: [{ function: { name: "read_file", arguments: { path: "nope" } } }], promptTokens: 7000 };
    }
    return { content: "final answer" };
  });
  try {
    const events: string[] = [];
    const prior: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "big" } } }] },
      { role: "tool", content: "B".repeat(6000), tool_name: "read_file" }, // oversized, NOT the last tool after this turn
      { role: "assistant", content: "a1" },
    ];
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: "." },
      userMessage: "next",
      model: "qwen2.5-coder:7b",
      priorMessages: prior,
      compaction: { numCtx: 8192, threshold: 0.75, keepRecent: 8, toolResultCap: 2000 },
      onEvent: (e) => events.push(e.type),
    });
    assert.equal(summaryCalls, 0, "truncation alone should avoid the LLM summary");
    assert.ok(events.includes("compaction"));
    assert.equal(res.stopReason, "completed");
    const bigTool = res.messages.find((mm) => mm.role === "tool" && mm.content.startsWith("B"));
    assert.match(bigTool?.content ?? "", /\[truncated/);
  } finally {
    await m.close();
  }
});
