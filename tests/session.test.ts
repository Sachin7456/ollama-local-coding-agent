// Auto-tests: session persistence + resume. Zero deps.
// QWEN_HARNESS_DIR points session storage at a temp dir so the real home is untouched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Session, listSessions, validateAndRecoverCwd, setSessionTitle, sessionTitle } from "../src/state/session.ts";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { runAgent } from "../src/agent/agent.ts";
import { createDefaultRegistry } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m8-"));
  process.env.QWEN_HARNESS_DIR = tmp;
});
after(async () => {
  delete process.env.QWEN_HARNESS_DIR;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("session titles: create / rename (append-only) / load + sessionTitle + listSessions", () => {
  const s = Session.create({ cwd: tmp, title: "My task" });
  s.appendMessage({ role: "user", content: "hello world" });
  assert.equal(Session.load(s.id).meta.title, "My task");
  setSessionTitle(s.id, "Renamed"); // appends a title line; latest wins
  assert.equal(Session.load(s.id).meta.title, "Renamed");
  assert.equal(sessionTitle({ title: "T", firstUser: "f" }), "T");
  assert.equal(sessionTitle({ firstUser: "first msg" }), "first msg");
  assert.equal(sessionTitle({}), "(untitled)");
  assert.equal(listSessions(tmp).find((r) => r.id === s.id)?.title, "Renamed");
});

function jsonModel(reply: (callIndex: number) => string) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const content = reply(calls++);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { role: "assistant", content, tool_calls: [] }, prompt_eval_count: 1, eval_count: 1, done: true }));
    });
  });
  return new Promise<{ client: OllamaClient; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ client: new OllamaClient(`http://127.0.0.1:${port}`), close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test("create writes a meta line and the file exists", () => {
  const s = Session.create({ model: "qwen2.5-coder:7b", cwd: "/tmp/x" });
  assert.ok(s.id.length > 0);
  const { meta, messages } = Session.load(s.id);
  assert.equal(meta.model, "qwen2.5-coder:7b");
  assert.equal(messages.length, 0);
});

test("appendMessage round-trips through load", () => {
  const s = Session.create();
  s.appendMessage({ role: "system", content: "sys" });
  s.appendMessage({ role: "user", content: "hello" });
  s.appendMessage({ role: "assistant", content: "hi back" });
  const { messages } = Session.load(s.id);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.equal(messages[2].content, "hi back");
});

test("open reopens an existing session for appending", () => {
  const s = Session.create();
  s.appendMessage({ role: "user", content: "first" });
  const { session, messages } = Session.open(s.id);
  assert.equal(messages.length, 1);
  session.appendMessage({ role: "assistant", content: "second" });
  assert.equal(Session.load(s.id).messages.length, 2);
});

test("listSessions reports saved sessions with a first-user snippet", () => {
  const s = Session.create();
  s.appendMessage({ role: "user", content: "find the bug in main.ts please" });
  const all = listSessions();
  const mine = all.find((x) => x.id === s.id);
  assert.ok(mine, "created session should be listed");
  assert.match(mine!.firstUser, /find the bug/);
  assert.ok(mine!.messages >= 1);
});

test("load throws for an unknown session", () => {
  assert.throws(() => Session.load("does-not-exist"), /Session not found/);
});

test("A3: listSessions(cwd) returns only THIS project's sessions", () => {
  const projA = path.join(tmp, "alpha");
  const projB = path.join(tmp, "beta");
  const a = Session.create({ cwd: projA });
  a.appendMessage({ role: "user", content: "alpha task" });
  const b = Session.create({ cwd: projB });
  b.appendMessage({ role: "user", content: "beta task" });
  const inA = listSessions(projA);
  assert.ok(inA.some((s) => s.id === a.id), "project A's session is listed for A");
  assert.ok(!inA.some((s) => s.id === b.id), "project B's session is NOT listed for A");
  // unfiltered still shows both
  const all = listSessions();
  assert.ok(all.some((s) => s.id === a.id) && all.some((s) => s.id === b.id));
});

test("A4: validateAndRecoverCwd keeps a real dir, falls back when it's gone", () => {
  const keep = validateAndRecoverCwd(tmp, "/fallback");
  assert.deepEqual(keep, { cwd: tmp, recovered: false });
  const gone = validateAndRecoverCwd(path.join(tmp, "definitely-not-here-123"), tmp);
  assert.deepEqual(gone, { cwd: tmp, recovered: true });
});

test("a session persisted via runAgent can be resumed and continued", async () => {
  const m = await jsonModel((i) => (i === 0 ? "First reply." : "Second reply."));
  try {
    const s = Session.create({ model: "qwen2.5-coder:7b" });
    const onMessage = (msg: { role: string; content: string }) => s.appendMessage(msg as never);

    // run 1 (fresh): system + user + assistant get persisted
    const r1 = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "first question",
      model: "qwen2.5-coder:7b",
      systemPrompt: "you are a test bot",
      onMessage,
    });
    assert.match(r1.text, /First reply/);

    // resume: load the transcript, continue with a new question
    const loaded = Session.load(s.id);
    assert.deepEqual(loaded.messages.map((x) => x.role), ["system", "user", "assistant"]);

    const r2 = await runAgent({
      client: m.client,
      registry: createDefaultRegistry(),
      permissions: createDefaultPermissions("default"),
      ctx: { cwd: tmp },
      userMessage: "second question",
      model: "qwen2.5-coder:7b",
      priorMessages: loaded.messages,
      onMessage,
    });
    assert.match(r2.text, /Second reply/);

    // the file now holds the whole continuous conversation (system once)
    const final = Session.load(s.id).messages;
    assert.deepEqual(final.map((x) => x.role), ["system", "user", "assistant", "user", "assistant"]);
    assert.equal(final.filter((x) => x.role === "system").length, 1);
  } finally {
    await m.close();
  }
});
