// Auto-tests: preferences load/normalize/save. Uses QWEN_HARNESS_DIR to redirect to a temp dir (no real ~).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PREFS, normalizePrefs, loadPrefs, savePrefs, prefsPath } from "../src/ui/prefs.ts";

let tmp: string;
let prev: string | undefined;
before(() => {
  prev = process.env.QWEN_HARNESS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qh-prefs-"));
  process.env.QWEN_HARNESS_DIR = tmp;
});
after(() => {
  if (prev === undefined) delete process.env.QWEN_HARNESS_DIR;
  else process.env.QWEN_HARNESS_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("normalizePrefs: defaults fill missing/invalid, valid kept", () => {
  assert.deepEqual(normalizePrefs({}), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
  assert.equal(normalizePrefs({ color: "purple" }).color, "auto"); // invalid → default
  assert.equal(normalizePrefs({ color: "never" }).color, "never");
  assert.equal(normalizePrefs({ verbosity: "quiet" }).verbosity, "quiet");
  assert.equal(normalizePrefs({ defaultModel: "qwen2.5-coder:7b" }).defaultModel, "qwen2.5-coder:7b");
  assert.equal(normalizePrefs({ defaultModel: 5 }).defaultModel, undefined); // non-string ignored
});

test("loadPrefs: missing file → defaults; malformed file → defaults", () => {
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS); // nothing written yet
  fs.writeFileSync(prefsPath(), "{ not json");
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
});

test("savePrefs + loadPrefs round-trip", () => {
  savePrefs({ color: "always", verbosity: "verbose", defaultModel: "m1" });
  const p = loadPrefs();
  assert.equal(p.color, "always");
  assert.equal(p.verbosity, "verbose");
  assert.equal(p.defaultModel, "m1");
});
