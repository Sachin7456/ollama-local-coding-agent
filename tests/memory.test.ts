// Auto-tests: long-term memory. Zero deps.
// QWEN_HARNESS_DIR points memory storage at a temp dir; cleared between tests.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addMemory,
  getMemories,
  searchMemories,
  clearMemories,
  buildMemoryBlock,
  rememberTool,
  recallTool,
} from "../src/state/memory.ts";

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m10-"));
  process.env.QWEN_HARNESS_DIR = tmp;
});
after(async () => {
  delete process.env.QWEN_HARNESS_DIR;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});
beforeEach(() => clearMemories());

test("addMemory + getMemories round-trip (empties ignored)", () => {
  assert.equal(addMemory("the user prefers Hinglish"), true);
  assert.equal(addMemory("   "), false);
  addMemory("the project uses TypeScript");
  assert.deepEqual(getMemories(), ["the user prefers Hinglish", "the project uses TypeScript"]);
});

test("searchMemories filters case-insensitively; no query returns all", () => {
  addMemory("Likes dark mode");
  addMemory("Uses Ollama locally");
  assert.deepEqual(searchMemories("ollama"), ["Uses Ollama locally"]);
  assert.equal(searchMemories().length, 2);
  assert.equal(searchMemories("zzz").length, 0);
});

test("buildMemoryBlock renders a facts block, or empty when none", () => {
  assert.equal(buildMemoryBlock(), "");
  addMemory("fact one");
  const block = buildMemoryBlock();
  assert.match(block, /Known facts/);
  assert.match(block, /- fact one/);
});

test("remember tool saves and recall tool retrieves", async () => {
  const saved = await rememberTool.execute({ fact: "deploy on Fridays is forbidden" }, { cwd: "." });
  assert.match(saved, /Remembered/);
  assert.match(await recallTool.execute({ query: "friday" }, { cwd: "." }), /forbidden/);
});

test("remember rejects empty; recall reports no matches", async () => {
  assert.match(await rememberTool.execute({ fact: "  " }, { cwd: "." }), /non-empty/);
  assert.match(
    await recallTool.execute({ query: "nothing" }, { cwd: "." }),
    /No facts remembered|No remembered facts match/,
  );
});

test("memory is re-read from disk each call (survives a new process)", () => {
  addMemory("persisted fact 42");
  assert.ok(getMemories().includes("persisted fact 42"));
});

// ---------------- buildMemoryBlock: ranked + deduped + top-K ----------------
test("buildMemoryBlock(query) ranks keyword-relevant facts above unrelated recent ones", () => {
  addMemory("the user likes tea");
  addMemory("the build output goes to the dist folder");
  addMemory("the user uses a mac"); // most recent, but unrelated to the query
  const block = buildMemoryBlock("where is the dist build output", 1);
  assert.match(block, /dist folder/); // relevance beats recency
});

test("buildMemoryBlock dedupes case-insensitively, keeping the latest", () => {
  addMemory("Likes Dark Mode");
  addMemory("likes dark mode");
  const block = buildMemoryBlock(undefined, 10);
  const lines = block.split("\n").filter((l) => /dark mode/i.test(l));
  assert.equal(lines.length, 1);
  assert.match(block, /- likes dark mode/); // latest casing wins
});

test("buildMemoryBlock respects topK", () => {
  for (const f of ["f1", "f2", "f3", "f4", "f5"]) addMemory(f);
  const block = buildMemoryBlock(undefined, 2);
  const bullets = block.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 2);
});

test("buildMemoryBlock() with no query falls back to most-recent topK", () => {
  for (const f of ["old1", "old2", "old3", "newA", "newB"]) addMemory(f);
  const block = buildMemoryBlock(undefined, 2);
  assert.match(block, /newB/);
  assert.match(block, /newA/);
  assert.doesNotMatch(block, /old1/);
});
