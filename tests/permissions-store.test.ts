// Auto-tests: persisted "always allow" rule store. Zero deps; uses a temp QWEN_HARNESS_DIR — no model.
// The store is PER-PROJECT (keyed by cwd) so approvals never leak across unrelated projects.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPermissionRules, rememberAllowRule } from "../src/permissions/permissionsStore.ts";
import { projectDir } from "../src/state/session.ts";

let tmp = "";
let cwd = ""; // a stable per-project key for these tests
const saved = process.env.QWEN_HARNESS_DIR;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-perms-"));
  process.env.QWEN_HARNESS_DIR = tmp;
  cwd = path.join(tmp, "proj");
});

after(async () => {
  if (saved === undefined) delete process.env.QWEN_HARNESS_DIR;
  else process.env.QWEN_HARNESS_DIR = saved;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("store: empty when no file exists", () => {
  assert.deepEqual(loadPermissionRules(cwd), []);
});

test("store: rememberAllowRule persists + loadPermissionRules round-trips (deduped)", () => {
  assert.equal(rememberAllowRule("bash", "npm test", cwd), true);
  assert.equal(rememberAllowRule("powershell", "Get-Process", cwd), true);
  assert.equal(rememberAllowRule("bash", "npm test", cwd), true); // dedupe — no second entry
  const rules = loadPermissionRules(cwd);
  assert.equal(rules.length, 2);
  assert.ok(rules.every((r) => r.decision === "allow" && typeof r.commandPrefix === "string"));
  assert.ok(rules.some((r) => r.tool === "bash" && r.commandPrefix === "npm test"));
  assert.ok(rules.some((r) => r.tool === "powershell" && r.commandPrefix === "Get-Process"));
});

test("store: persists a schema version and leaves no temp file (atomic write)", async () => {
  assert.equal(rememberAllowRule("bash", "ls -la", cwd), true);
  const dir = projectDir(cwd);
  const raw = JSON.parse(await fs.readFile(path.join(dir, "permissions.json"), "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Array.isArray(raw.allow) && raw.allow.some((r: { commandPrefix: string }) => r.commandPrefix === "ls -la"));
  await assert.rejects(fs.stat(path.join(dir, "permissions.json.tmp"))); // temp file must not linger
});

test("store: an OLD versionless {allow:[…]} file still loads (forward-compat)", async () => {
  const dir = projectDir(cwd);
  await fs.writeFile(
    path.join(dir, "permissions.json"),
    JSON.stringify({ allow: [{ tool: "bash", commandPrefix: "git status" }] }),
  );
  assert.ok(loadPermissionRules(cwd).some((r) => r.commandPrefix === "git status"));
});

test("store: rules are PER-PROJECT (an approval in project A doesn't apply in project B)", () => {
  const projA = path.join(tmp, "alpha");
  const projB = path.join(tmp, "beta");
  assert.equal(rememberAllowRule("bash", "rm -rf node_modules", projA), true);
  assert.ok(loadPermissionRules(projA).some((r) => r.commandPrefix === "rm -rf node_modules"));
  assert.equal(loadPermissionRules(projB).length, 0); // isolated — does not carry into project B
});
