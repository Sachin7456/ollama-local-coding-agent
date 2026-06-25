// Auto-tests: the agent loop, driven by a SCRIPTED mock model server.
// Zero deps. No real model — a local node:http server returns canned model
// responses in sequence, so we can test the whole loop deterministically.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { createDefaultRegistry, ToolRegistry, type Tool } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";
import { runAgent, validateArgs } from "../src/agent/agent.ts";

// ---- a scripted model: handler(callIndex) -> Ollama response message ----
type ModelReply = { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };

function scriptedModel(replyFor: (callIndex: number) => ModelReply) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const reply = replyFor(calls++);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: reply.content ?? "", tool_calls: reply.tool_calls ?? [] },
          prompt_eval_count: 5,
          eval_count: 5,
          done: true,
        }),
      );
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void>; callCount: () => number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new OllamaClient(`http://127.0.0.1:${port}`),
        close: () => new Promise<void>((r) => server.close(() => r())),
        callCount: () => calls,
      });
    });
  });
}

const toolCall = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

// a fake mutating tool for permission paths
const writeTool: Tool = {
  name: "write_file",
  description: "write a file",
  readOnly: false,
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
  execute: async () => "wrote ok",
};
const bashTool: Tool = {
  name: "bash",
  description: "run a shell command",
  readOnly: false,
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
  execute: async () => "(ran)",
};

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m4-"));
  await fs.writeFile(path.join(tmp, "a.txt"), "hello world\n");
});
after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------- happy path: tool call then final answer ----------------
test("loop runs a tool call, feeds the result back, then finishes", async () => {
  const m = await scriptedModel((i) =>
    i === 0 ? { tool_calls: [toolCall("read_file", { path: "a.txt" })] } : { content: "The file says hello world." },
  );
  try {
    const events: string[] = [];
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "what's in a.txt?",
      onEvent: (e) => events.push(e.type),
    });
    assert.equal(res.stopReason, "completed");
    assert.equal(res.turns, 2);
    assert.match(res.text, /hello world/);
    // the tool result message must contain the actual file content
    const toolMsg = res.messages.find((mm) => mm.role === "tool");
    assert.match(toolMsg?.content ?? "", /hello world/);
    assert.ok(events.includes("tool_result"));
  } finally {
    await m.close();
  }
});

// ---------------- permission: ask -> denied vs approved ----------------
test("mutating tool is denied when onAsk says no (default headless = deny)", async () => {
  const m = await scriptedModel((i) =>
    i === 0 ? { tool_calls: [toolCall("write_file", { path: "x.txt", content: "hi" })] } : { content: "ok, I won't write." },
  );
  try {
    const registry = createDefaultRegistry().register(writeTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "write x.txt",
      // no onAsk => default deny
    });
    const toolMsg = res.messages.find((mm) => mm.role === "tool");
    assert.match(toolMsg?.content ?? "", /denied/i);
    assert.doesNotMatch(toolMsg?.content ?? "", /wrote ok/);
  } finally {
    await m.close();
  }
});

test("mutating tool runs when onAsk approves", async () => {
  const m = await scriptedModel((i) =>
    i === 0 ? { tool_calls: [toolCall("write_file", { path: "x.txt", content: "hi" })] } : { content: "done." },
  );
  try {
    const registry = createDefaultRegistry().register(writeTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "write x.txt",
      onAsk: () => true,
    });
    const toolMsg = res.messages.find((mm) => mm.role === "tool");
    assert.match(toolMsg?.content ?? "", /wrote ok/);
    assert.equal(res.stopReason, "completed");
  } finally {
    await m.close();
  }
});

// ---------------- validation + repair ----------------
test("invalid tool args produce repair feedback, then the model corrects", async () => {
  const m = await scriptedModel((i) => {
    if (i === 0) return { tool_calls: [toolCall("read_file", {})] }; // missing path
    if (i === 1) return { tool_calls: [toolCall("read_file", { path: "a.txt" })] };
    return { content: "Recovered and read it." };
  });
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "read it",
    });
    const toolMsgs = res.messages.filter((mm) => mm.role === "tool");
    assert.match(toolMsgs[0].content, /invalid arguments/i);
    assert.match(toolMsgs[1].content, /hello world/);
    assert.equal(res.stopReason, "completed");
  } finally {
    await m.close();
  }
});

test("unknown tool returns an error listing available tools", async () => {
  const m = await scriptedModel((i) =>
    i === 0 ? { tool_calls: [toolCall("nope", {})] } : { content: "ok" },
  );
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "do a thing",
    });
    const toolMsg = res.messages.find((mm) => mm.role === "tool");
    assert.match(toolMsg?.content ?? "", /unknown tool/i);
    assert.match(toolMsg?.content ?? "", /read_file/);
  } finally {
    await m.close();
  }
});

// ---------------- loop guards ----------------
test("maxTurns stops a model that never stops calling tools", async () => {
  // vary args per turn so the loop guard doesn't trip — this test is about maxTurns only.
  const m = await scriptedModel((i) => ({ tool_calls: [toolCall("read_file", { path: `a${i}.txt` })] }));
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "loop forever",
      maxTurns: 3,
    });
    assert.equal(res.stopReason, "max_turns");
    assert.equal(res.turns, 3);
  } finally {
    await m.close();
  }
});

test("loop guard stops a model repeating the SAME tool call (before maxTurns)", async () => {
  const m = await scriptedModel(() => ({ tool_calls: [toolCall("read_file", { path: "a.txt" })] }));
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "read it over and over",
      maxTurns: 12,
    });
    assert.equal(res.stopReason, "loop"); // stopped by the loop guard, NOT maxTurns
    assert.equal(res.turns, 3); // the 3rd identical turn
    assert.equal(m.callCount(), 3);
    assert.ok(
      res.messages.some((x) => x.role === "user" && /repeated the same action/.test(x.content ?? "")),
      "a loop warning was injected on the 2nd identical turn",
    );
  } finally {
    await m.close();
  }
});

test("loop guard does NOT trip on a normal multi-step sequence", async () => {
  const m = await scriptedModel((i) =>
    i === 0
      ? { tool_calls: [toolCall("read_file", { path: "a.txt" })] }
      : i === 1
        ? { tool_calls: [toolCall("read_file", { path: "p1.txt" })] }
        : { content: "All done." },
  );
  try {
    await fs.writeFile(path.join(tmp, "p1.txt"), "second\n");
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "read two files then summarize",
      maxTurns: 12,
    });
    assert.equal(res.stopReason, "completed");
    assert.match(res.text, /All done/);
    assert.ok(!res.messages.some((x) => x.role === "user" && /repeated the same action/.test(x.content ?? "")));
  } finally {
    await m.close();
  }
});

test("circuit breaker stops after repeated denied (dangerous) calls", async () => {
  // vary the command per turn so the loop guard doesn't trip — this tests the denial breaker.
  const m = await scriptedModel((i) => ({ tool_calls: [toolCall("bash", { command: `rm -rf /tmp/x${i}` })] }));
  try {
    const registry = createDefaultRegistry().register(bashTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "destroy everything",
      maxTurns: 10,
    });
    assert.equal(res.stopReason, "circuit_breaker");
    assert.equal(res.turns, 3);
  } finally {
    await m.close();
  }
});

// ---------------- pure: validateArgs ----------------
test("validateArgs flags missing required, wrong type, and unexpected props", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "number" } },
    required: ["path"],
    additionalProperties: false,
  };
  assert.equal(validateArgs(schema, { path: "a", limit: 5 }).ok, true);
  assert.match(validateArgs(schema, {}).errors.join(), /missing required.*path/);
  assert.match(validateArgs(schema, { path: 1 }).errors.join(), /should be string/);
  assert.match(validateArgs(schema, { path: "a", extra: 1 }).errors.join(), /unexpected property/);
});

// ---------------- content-embedded tool-call recovery (the real smoke-test failure) ----------------
test("loop recovers a content-embedded tool call (qwen2.5 style) and runs it", async () => {
  const m = await scriptedModel((i) =>
    i === 0
      ? { content: '{"name": "read_file", "arguments": {"path": "a.txt"}}' } // embedded in content: no tool_calls array
      : { content: "The file says hello world." },
  );
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "read a.txt",
    });
    const toolMsg = res.messages.find((mm) => mm.role === "tool");
    assert.match(toolMsg?.content ?? "", /hello world/); // the tool actually ran
    assert.equal(res.stopReason, "completed");
    assert.equal(res.turns, 2);
  } finally {
    await m.close();
  }
});

// ---------------- think-strip + idle nudge (small-model "act, don't narrate") ----------------
test("a thinking-only turn is nudged once, then the model acts", async () => {
  const m = await scriptedModel((i) =>
    i === 0
      ? { content: "<think>I can read the dir</think>" } // empty after strip, no tool call
      : i === 1
        ? { tool_calls: [toolCall("read_file", { path: "a.txt" })] }
        : { content: "Done reading." },
  );
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "explain the folder",
    });
    assert.equal(res.stopReason, "completed");
    assert.equal(res.turns, 3);
    assert.equal(m.callCount(), 3);
    assert.ok(
      res.messages.some((x) => x.role === "user" && /did not call a tool/.test(x.content ?? "")),
      "a corrective nudge was injected",
    );
    assert.match(res.text, /Done reading/);
  } finally {
    await m.close();
  }
});

test("a <think> + real-answer turn completes with clean text and no nudge", async () => {
  const m = await scriptedModel(() => ({ content: "<think>plan plan</think>The folder has 3 files." }));
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "x",
    });
    assert.equal(res.turns, 1);
    assert.equal(res.stopReason, "completed");
    assert.equal(res.text, "The folder has 3 files."); // reasoning stripped, answer kept
    assert.ok(!res.text.includes("<think>") && !res.text.includes("plan"));
    assert.equal(m.callCount(), 1);
  } finally {
    await m.close();
  }
});

test("a model that only ever thinks is nudged once, then stops (no infinite loop)", async () => {
  const m = await scriptedModel(() => ({ content: "<think>still thinking…</think>" }));
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "x",
    });
    assert.equal(res.stopReason, "completed");
    assert.equal(res.turns, 2); // turn 1 nudged, turn 2 capped -> stop
    assert.equal(m.callCount(), 2);
    assert.equal(res.text, "");
  } finally {
    await m.close();
  }
});

test("plain prose with no tool call is still accepted as the final answer (no nudge)", async () => {
  const m = await scriptedModel(() => ({ content: "I think the answer is 42." }));
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "x",
    });
    assert.equal(res.turns, 1);
    assert.match(res.text, /42/);
    assert.ok(
      !res.messages.some((x) => x.role === "user" && /did not call a tool/.test(x.content ?? "")),
      "no nudge for non-empty prose",
    );
  } finally {
    await m.close();
  }
});

// ---------------- parallel tool calls (multiple in one turn) ----------------
test("runs multiple read tool calls in one turn, recording results in tool_call order", async () => {
  await fs.writeFile(path.join(tmp, "p1.txt"), "FIRST file\n");
  await fs.writeFile(path.join(tmp, "p2.txt"), "SECOND file\n");
  const m = await scriptedModel((i) =>
    i === 0
      ? { tool_calls: [toolCall("read_file", { path: "p1.txt" }), toolCall("read_file", { path: "p2.txt" })] }
      : { content: "read both." },
  );
  try {
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "read both files",
    });
    const toolMsgs = res.messages.filter((mm) => mm.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.match(toolMsgs[0].content, /FIRST file/); // original tool_call order preserved
    assert.match(toolMsgs[1].content, /SECOND file/);
    assert.equal(res.stopReason, "completed");
    assert.equal(res.turns, 2);
  } finally {
    await m.close();
  }
});

test("multiple denied calls in a single turn trip the circuit breaker that turn", async () => {
  const m = await scriptedModel(() => ({
    tool_calls: [
      toolCall("bash", { command: "rm -rf /" }),
      toolCall("bash", { command: "rm -rf /" }),
      toolCall("bash", { command: "rm -rf /" }),
    ],
  }));
  try {
    const registry = createDefaultRegistry().register(bashTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "destroy",
      maxTurns: 5,
    });
    assert.equal(res.stopReason, "circuit_breaker");
    assert.equal(res.turns, 1); // three denials in the SAME turn trip it
  } finally {
    await m.close();
  }
});

test("an allowed call resets the denial counter mid-turn (order-sensitive)", async () => {
  const m = await scriptedModel((i) =>
    i === 0
      ? {
          tool_calls: [
            toolCall("bash", { command: "rm -rf /" }), // denied -> 1
            toolCall("read_file", { path: "a.txt" }), // allowed -> reset 0
            toolCall("bash", { command: "rm -rf /" }), // denied -> 1
          ],
        }
      : { content: "ok" },
  );
  try {
    const registry = createDefaultRegistry().register(bashTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "mix",
      maxTurns: 5,
    });
    assert.equal(res.stopReason, "completed"); // ended at 1 denial, no breaker
    assert.equal(res.turns, 2);
  } finally {
    await m.close();
  }
});

test("multiple onAsk prompts resolve in tool_call order", async () => {
  const asked: string[] = [];
  const m = await scriptedModel((i) =>
    i === 0
      ? { tool_calls: [toolCall("write_file", { path: "x.txt", content: "1" }), toolCall("write_file", { path: "y.txt", content: "2" })] }
      : { content: "done" },
  );
  try {
    const registry = createDefaultRegistry().register(writeTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "write two",
      onAsk: (info) => {
        asked.push(String(info.args.path));
        return true;
      },
    });
    assert.deepEqual(asked, ["x.txt", "y.txt"]); // prompts never raced, stayed in order
    const toolMsgs = res.messages.filter((mm) => mm.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.match(toolMsgs[0].content, /wrote ok/);
    assert.match(toolMsgs[1].content, /wrote ok/);
  } finally {
    await m.close();
  }
});

test("a denied call and an allowed call in one turn keep original message order", async () => {
  const m = await scriptedModel((i) =>
    i === 0
      ? { tool_calls: [toolCall("write_file", { path: "z.txt", content: "9" }), toolCall("read_file", { path: "a.txt" })] }
      : { content: "ok" },
  );
  try {
    const registry = createDefaultRegistry().register(writeTool);
    const res = await runAgent({
      client: m.client,
      registry,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "mix order",
      // no onAsk -> write_file denied
    });
    const toolMsgs = res.messages.filter((mm) => mm.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.match(toolMsgs[0].content, /denied/i); // write_file (first)
    assert.match(toolMsgs[1].content, /hello world/); // read_file (second)
  } finally {
    await m.close();
  }
});

// ---------------- abort / cancel ----------------
test("runAgent stops cleanly when the signal is already aborted (no model call)", async () => {
  const m = await scriptedModel(() => ({ content: "should not be reached" }));
  try {
    const ac = new AbortController();
    ac.abort();
    const res = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "hello",
      signal: ac.signal,
    });
    assert.equal(res.stopReason, "aborted");
    assert.equal(m.callCount(), 0); // the model was never called
  } finally {
    await m.close();
  }
});
