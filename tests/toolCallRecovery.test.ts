// Auto-tests: tool-call content-embedded recovery. Zero deps, pure logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverToolCallsFromContent, extractJsonObject, stripThink } from "../src/agent/toolCallRecovery.ts";

const known = (n: string) => ["read_file", "grep", "bash"].includes(n);

test("recovers a bare JSON tool call from content (the real qwen2.5 failure)", () => {
  const r = recoverToolCallsFromContent('{"name": "read_file", "arguments": {"path": "sample.txt"}}', known);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "read_file");
  assert.deepEqual(r.toolCalls[0].function.arguments, { path: "sample.txt" });
  assert.equal(r.cleanedText, "");
});

test("recovers a fenced ```json tool call and keeps surrounding prose", () => {
  const r = recoverToolCallsFromContent('Sure!\n```json\n{"name":"grep","arguments":{"pattern":"foo"}}\n```\n', known);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "grep");
  assert.match(r.cleanedText, /Sure!/);
});

test("recovers a Hermes <tool_call> block", () => {
  const r = recoverToolCallsFromContent('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>', known);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "bash");
  assert.deepEqual(r.toolCalls[0].function.arguments, { command: "ls" });
});

test("tolerates arguments-as-string and the 'parameters' key", () => {
  const a = recoverToolCallsFromContent('{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}', known);
  assert.deepEqual(a.toolCalls[0].function.arguments, { path: "x" });
  const b = recoverToolCallsFromContent('{"name":"grep","parameters":{"pattern":"y"}}', known);
  assert.deepEqual(b.toolCalls[0].function.arguments, { pattern: "y" });
});

test("does NOT treat a normal JSON answer or unknown tool as a tool call", () => {
  assert.equal(recoverToolCallsFromContent('{"answer": 42, "note": "hi"}', known).toolCalls.length, 0);
  assert.equal(recoverToolCallsFromContent('{"name":"not_a_tool","arguments":{}}', known).toolCalls.length, 0);
});

test("plain prose stays untouched", () => {
  const r = recoverToolCallsFromContent("The answer is 42.", known);
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.cleanedText, "The answer is 42.");
});

test("extractJsonObject pulls the first balanced object out of prose", () => {
  assert.deepEqual(extractJsonObject('blah {"a": {"b": 1}} trailing'), { a: { b: 1 } });
  assert.equal(extractJsonObject("no json here"), null);
});

// ---------------- stripThink (qwen3 <think>…</think> reasoning) ----------------
test("stripThink removes reasoning and keeps the answer", () => {
  assert.equal(stripThink("<think>plan plan</think>The file is empty."), "The file is empty.");
  assert.equal(stripThink("</think>answer"), "answer"); // lone leading close (open eaten by template)
  assert.equal(stripThink("<think>truncated reasoning"), ""); // unclosed
  assert.equal(stripThink("no tags here"), "no tags here");
  assert.equal(stripThink(""), "");
});

test("strips a <think> block, then recovers the embedded tool call", () => {
  const r = recoverToolCallsFromContent('<think>I should read it</think>{"name":"read_file","arguments":{"path":"a.txt"}}', known);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "read_file");
  assert.equal(r.cleanedText, "");
});
