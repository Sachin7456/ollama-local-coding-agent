// Auto-tests: optional per-project rules file loading (B14). Zero deps; real temp dir, no model.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadProjectRules, findProjectRulesFile, projectRulesIdentity } from "../src/state/projectRules.ts";

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-proj-"));
});
after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("loadProjectRules returns '' when no project file exists", () => {
  assert.equal(loadProjectRules(tmp), "");
});

test("loadProjectRules loads AGENTS.md as a prompt block", async () => {
  await fs.writeFile(path.join(tmp, "AGENTS.md"), "Always answer in French.");
  const out = loadProjectRules(tmp);
  assert.match(out, /Project rules/);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /answer in French/);
});

test("loadProjectRules prefers .qwen-harness.md over AGENTS.md", async () => {
  await fs.writeFile(path.join(tmp, ".qwen-harness.md"), "from qwen-harness");
  assert.match(loadProjectRules(tmp), /from qwen-harness/);
});

test("findProjectRulesFile: null when none / empty, the name when present", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-find-"));
  try {
    assert.equal(findProjectRulesFile(dir), null);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "   \n  "); // whitespace-only → ignored (matches loadProjectRules)
    assert.equal(findProjectRulesFile(dir), null);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "real content");
    assert.equal(findProjectRulesFile(dir), "AGENTS.md");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("findProjectRulesFile: prefers .qwen-harness.md over AGENTS.md", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-find2-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "a");
    await fs.writeFile(path.join(dir, ".qwen-harness.md"), "b");
    assert.equal(findProjectRulesFile(dir), ".qwen-harness.md");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("A2 projectRulesIdentity: null when none; {name, sha256(content)} when present", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-id-"));
  try {
    assert.equal(projectRulesIdentity(dir), null);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "hello rules");
    const id = projectRulesIdentity(dir);
    assert.equal(id?.name, "AGENTS.md");
    assert.equal(id?.hash, createHash("sha256").update("hello rules").digest("hex")); // hashes raw content
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
