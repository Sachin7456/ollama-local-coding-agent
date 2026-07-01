// Auto-tests: persisted command history (file glue around readline). QWEN_HARNESS_DIR → temp dir.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHistorySeed, saveHistory, attachHistory, historyPath } from "../src/ui/history.ts";

let tmp: string;
let prev: string | undefined;
before(() => {
  prev = process.env.QWEN_HARNESS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qh-hist-"));
  process.env.QWEN_HARNESS_DIR = tmp;
});
after(() => {
  if (prev === undefined) delete process.env.QWEN_HARNESS_DIR;
  else process.env.QWEN_HARNESS_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("missing history → empty seed", () => {
  assert.deepEqual(loadHistorySeed(), []);
});

test("save (newest-first) writes oldest-first; load returns newest-first (round-trip)", () => {
  saveHistory(["c3", "c2", "c1"]); // readline order: c3 is most recent
  assert.equal(fs.readFileSync(historyPath(), "utf8"), "c1\nc2\nc3\n"); // file is oldest-first
  assert.deepEqual(loadHistorySeed(), ["c3", "c2", "c1"]);
});

test("cap keeps the newest N", () => {
  saveHistory(["e", "d", "c", "b", "a"], 3); // newest-first; keep newest 3 = e,d,c
  assert.deepEqual(loadHistorySeed(10), ["e", "d", "c"]);
});

test("attachHistory persists on the readline 'history' event", () => {
  let handler: ((h: string[]) => void) | undefined;
  attachHistory({ on: (_e, cb) => { handler = cb; } });
  assert.equal(typeof handler, "function");
  handler!(["z", "y"]);
  assert.deepEqual(loadHistorySeed(), ["z", "y"]);
});
