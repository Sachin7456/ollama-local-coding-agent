// Auto-tests: optional per-project rules file loading (B14). Zero deps; real temp dir, no model.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectRules } from "../src/state/projectRules.ts";

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
