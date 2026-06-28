// Auto-tests: long-term memory. Zero deps.
// QWEN_HARNESS_DIR points memory storage at a temp dir; memory is PER-PROJECT (keyed by cwd).

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
let cwd = ""; // a stable per-project key for these tests
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m10-"));
  process.env.QWEN_HARNESS_DIR = tmp;
  cwd = path.join(tmp, "proj");
});
after(async () => {
  delete process.env.QWEN_HARNESS_DIR;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});
beforeEach(() => clearMemories(cwd));

test("addMemory + getMemories round-trip (empties ignored)", () => {
  assert.equal(addMemory("the user prefers Hinglish", cwd), true);
  assert.equal(addMemory("   ", cwd), false);
  addMemory("the project uses TypeScript", cwd);
  assert.deepEqual(getMemories(cwd), ["the user prefers Hinglish", "the project uses TypeScript"]);
});

test("searchMemories filters case-insensitively; no query returns all", () => {
  addMemory("Likes dark mode", cwd);
  addMemory("Uses Ollama locally", cwd);
  assert.deepEqual(searchMemories("ollama", cwd), ["Uses Ollama locally"]);
  assert.equal(searchMemories(undefined, cwd).length, 2);
  assert.equal(searchMemories("zzz", cwd).length, 0);
});

test("buildMemoryBlock renders a facts block, or empty when none", () => {
  assert.equal(buildMemoryBlock(cwd), "");
  addMemory("fact one", cwd);
  const block = buildMemoryBlock(cwd);
  assert.match(block, /Known facts/);
  assert.match(block, /- fact one/);
});

test("remember tool saves and recall tool retrieves", async () => {
  const saved = await rememberTool.execute({ fact: "deploy on Fridays is forbidden" }, { cwd });
  assert.match(saved, /Remembered/);
  assert.match(await recallTool.execute({ query: "friday" }, { cwd }), /forbidden/);
});

test("remember rejects empty; recall reports no matches", async () => {
  assert.match(await rememberTool.execute({ fact: "  " }, { cwd }), /non-empty/);
  assert.match(
    await recallTool.execute({ query: "nothing" }, { cwd }),
    /No facts remembered|No remembered facts match/,
  );
});

test("memory is re-read from disk each call (survives a new process)", () => {
  addMemory("persisted fact 42", cwd);
  assert.ok(getMemories(cwd).includes("persisted fact 42"));
});

test("memory is PER-PROJECT: a fact saved in one project is not visible in another", () => {
  const projA = path.join(tmp, "alpha");
  const projB = path.join(tmp, "beta");
  addMemory("alpha-only secret", projA);
  assert.ok(getMemories(projA).includes("alpha-only secret"));
  assert.equal(getMemories(projB).length, 0); // isolated — does not cross into another project
  assert.equal(searchMemories("alpha-only", projB).length, 0);
});

// ---------------- buildMemoryBlock: ranked + deduped + top-K ----------------
test("buildMemoryBlock(query) ranks keyword-relevant facts above unrelated recent ones", () => {
  addMemory("the user likes tea", cwd);
  addMemory("the build output goes to the dist folder", cwd);
  addMemory("the user uses a mac", cwd); // most recent, but unrelated to the query
  const block = buildMemoryBlock(cwd, "where is the dist build output", 1);
  assert.match(block, /dist folder/); // relevance beats recency
});

test("buildMemoryBlock dedupes case-insensitively, keeping the latest", () => {
  addMemory("Likes Dark Mode", cwd);
  addMemory("likes dark mode", cwd);
  const block = buildMemoryBlock(cwd, undefined, 10);
  const lines = block.split("\n").filter((l) => /dark mode/i.test(l));
  assert.equal(lines.length, 1);
  assert.match(block, /- likes dark mode/); // latest casing wins
});

test("buildMemoryBlock respects topK", () => {
  for (const f of ["f1", "f2", "f3", "f4", "f5"]) addMemory(f, cwd);
  const block = buildMemoryBlock(cwd, undefined, 2);
  const bullets = block.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 2);
});

test("buildMemoryBlock() with no query falls back to most-recent topK", () => {
  for (const f of ["old1", "old2", "old3", "newA", "newB"]) addMemory(f, cwd);
  const block = buildMemoryBlock(cwd, undefined, 2);
  assert.match(block, /newB/);
  assert.match(block, /newA/);
  assert.doesNotMatch(block, /old1/);
});
