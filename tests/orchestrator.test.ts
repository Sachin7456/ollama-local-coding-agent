// Auto-tests: multi-agent orchestration with a cap of two concurrent generations.
// Zero deps. A mock model server (branching on body.model) tracks how many
// generations run concurrently — proving the gate caps it at 2. No real model.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { Semaphore } from "../src/orchestration/gate.ts";
import { runAgent } from "../src/agent/agent.ts";
import { createDefaultRegistry } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";
import { makeSpawnAgentsTool, runOrchestrator, type OrchestratorDeps } from "../src/orchestration/orchestrator.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

function modelServer(reply: (model: string, callIndex: number) => Reply, delayMs = 35) {
  let inFlight = 0;
  let maxInFlight = 0;
  const counters = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = data ? JSON.parse(data) : {};
      const model: string = body.model ?? "";
      const idx = counters.get(model) ?? 0;
      counters.set(model, idx + 1);
      await delay(delayMs); // hold the connection so overlap is observable
      const r = reply(model, idx);
      inFlight--;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: r.content ?? "", tool_calls: r.tool_calls ?? [] },
          prompt_eval_count: 1,
          eval_count: 1,
          done: true,
        }),
      );
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void>; maxInFlight: () => number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new OllamaClient(`http://127.0.0.1:${port}`),
        close: () => new Promise<void>((r) => server.close(() => r())),
        maxInFlight: () => maxInFlight,
      });
    });
  });
}

test("the gate caps concurrent generations at 2 across many agents", async () => {
  const srv = await modelServer(() => ({ content: "done" }), 40);
  try {
    const gate = new Semaphore(2);
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        runAgent({
          client: srv.client,
          registry: createDefaultRegistry(),
          permissions: createDefaultPermissions("default"),
          ctx: { cwd: "." },
          userMessage: `task ${i}`,
          model: "qwen2.5-coder:7b",
          gate,
        }),
      ),
    );
    assert.ok(srv.maxInFlight() <= 2, `server saw ${srv.maxInFlight()} concurrent generations, expected <= 2`);
    assert.ok(gate.peakCount <= 2);
    assert.equal(gate.activeCount, 0);
  } finally {
    await srv.close();
  }
});

test("spawn_agents runs one worker per task, in parallel, capped at 2", async () => {
  const srv = await modelServer((model) => ({ content: `worker handled it (${model})` }), 30);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m7-"));
  try {
    const deps: OrchestratorDeps = {
      client: srv.client,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      gate: new Semaphore(2),
      orchestratorModel: "qwen3-coder:30b",
      workerModel: "qwen2.5-coder:7b",
      maxWorkerTurns: 3,
    };
    const tool = makeSpawnAgentsTool(deps);
    const out = await tool.execute({ tasks: ["t1", "t2", "t3", "t4"] }, deps.ctx);
    assert.match(out, /Subagent 1/);
    assert.match(out, /Subagent 4/);
    assert.ok(srv.maxInFlight() <= 2, `saw ${srv.maxInFlight()} concurrent, expected <= 2`);
  } finally {
    await srv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("spawn_agents rejects an empty task list", async () => {
  const srv = await modelServer(() => ({ content: "x" }));
  try {
    const deps: OrchestratorDeps = {
      client: srv.client,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: "." },
      gate: new Semaphore(2),
      orchestratorModel: "qwen3-coder:30b",
      workerModel: "qwen2.5-coder:7b",
    };
    assert.match(await makeSpawnAgentsTool(deps).execute({ tasks: [] }, deps.ctx), /non-empty/);
  } finally {
    await srv.close();
  }
});

test("runOrchestrator delegates via spawn_agents then synthesizes a final answer", async () => {
  const srv = await modelServer((model, idx) => {
    if (model === "qwen3-coder:30b") {
      return idx === 0
        ? { tool_calls: [{ function: { name: "spawn_agents", arguments: { tasks: ["do A", "do B", "do C"] } } }] }
        : { content: "All subtasks complete: A, B and C are done." };
    }
    return { content: "worker finished its task" }; // worker model
  }, 30);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m7e-"));
  try {
    const deps: OrchestratorDeps = {
      client: srv.client,
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      gate: new Semaphore(2),
      orchestratorModel: "qwen3-coder:30b",
      workerModel: "qwen2.5-coder:7b",
      maxWorkerTurns: 3,
    };
    const res = await runOrchestrator({ task: "Do A, B and C in parallel", deps });
    assert.equal(res.stopReason, "completed");
    assert.match(res.text, /All subtasks complete/);
    const spawnMsg = res.messages.find((m) => m.role === "tool" && m.tool_name === "spawn_agents");
    assert.match(spawnMsg?.content ?? "", /Subagent 1/);
    assert.match(spawnMsg?.content ?? "", /Subagent 3/);
    assert.ok(srv.maxInFlight() <= 2, `saw ${srv.maxInFlight()} concurrent, expected <= 2 (no deadlock, no over-cap)`);
  } finally {
    await srv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---- A8: project rules thread into the orchestrator + worker system prompts ----
function capturingModelServer(reply: (model: string, idx: number) => Reply) {
  const sysByModel = new Map<string, string[]>();
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : {};
      const model: string = body.model ?? "";
      const sys = (body.messages ?? []).find((m: { role?: string }) => m.role === "system")?.content ?? "";
      const arr = sysByModel.get(model) ?? [];
      arr.push(String(sys));
      sysByModel.set(model, arr);
      const r = reply(model, arr.length - 1);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { role: "assistant", content: r.content ?? "", tool_calls: r.tool_calls ?? [] }, prompt_eval_count: 1, eval_count: 1, done: true }));
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void>; sysFor: (m: string) => string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new OllamaClient(`http://127.0.0.1:${port}`),
        close: () => new Promise<void>((r) => server.close(() => r())),
        sysFor: (m) => (sysByModel.get(m) ?? []).join("\n"),
      });
    });
  });
}

const orchReply = (model: string, idx: number): Reply =>
  model === "qwen3-coder:30b"
    ? idx === 0
      ? { tool_calls: [{ function: { name: "spawn_agents", arguments: { tasks: ["do A"] } } }] }
      : { content: "done" }
    : { content: "worker done" };

test("A8: a trusted project's rules thread into BOTH the orchestrator and worker system prompts", async () => {
  const srv = await capturingModelServer(orchReply);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-a8-"));
  try {
    const deps: OrchestratorDeps = {
      client: srv.client, permissions: createDefaultPermissions("default"), ctx: { cwd: tmp },
      gate: new Semaphore(2), orchestratorModel: "qwen3-coder:30b", workerModel: "qwen2.5-coder:7b",
      maxWorkerTurns: 3, projectRules: "Project rules (from AGENTS.md — follow these for this project):\nAlways answer in French.",
    };
    await runOrchestrator({ task: "go", deps });
    assert.match(srv.sysFor("qwen3-coder:30b"), /You are the ORCHESTRATOR/); // base framing kept
    assert.match(srv.sysFor("qwen3-coder:30b"), /answer in French/); // + rules threaded
    assert.match(srv.sysFor("qwen2.5-coder:7b"), /worker agent/);
    assert.match(srv.sysFor("qwen2.5-coder:7b"), /answer in French/);
  } finally {
    await srv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("A8: without projectRules, no rules block is added (regression guard)", async () => {
  const srv = await capturingModelServer(orchReply);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-a8n-"));
  try {
    const deps: OrchestratorDeps = {
      client: srv.client, permissions: createDefaultPermissions("default"), ctx: { cwd: tmp },
      gate: new Semaphore(2), orchestratorModel: "qwen3-coder:30b", workerModel: "qwen2.5-coder:7b", maxWorkerTurns: 3,
    };
    await runOrchestrator({ task: "go", deps });
    assert.match(srv.sysFor("qwen2.5-coder:7b"), /worker agent/);
    assert.doesNotMatch(srv.sysFor("qwen3-coder:30b"), /Project rules/);
    assert.doesNotMatch(srv.sysFor("qwen2.5-coder:7b"), /Project rules/);
  } finally {
    await srv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
