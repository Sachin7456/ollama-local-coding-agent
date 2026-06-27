// Auto-tests: persisted "always allow" rule store. Zero deps; uses a temp QWEN_HARNESS_DIR — no model.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPermissionRules, rememberAllowRule } from "../src/permissions/permissionsStore.ts";

let tmp = "";
const saved = process.env.QWEN_HARNESS_DIR;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-perms-"));
  process.env.QWEN_HARNESS_DIR = tmp;
});

after(async () => {
  if (saved === undefined) delete process.env.QWEN_HARNESS_DIR;
  else process.env.QWEN_HARNESS_DIR = saved;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("store: empty when no file exists", () => {
  assert.deepEqual(loadPermissionRules(), []);
});

test("store: rememberAllowRule persists + loadPermissionRules round-trips (deduped)", () => {
  assert.equal(rememberAllowRule("bash", "npm test"), true);
  assert.equal(rememberAllowRule("powershell", "Get-Process"), true);
  assert.equal(rememberAllowRule("bash", "npm test"), true); // dedupe — no second entry
  const rules = loadPermissionRules();
  assert.equal(rules.length, 2);
  assert.ok(rules.every((r) => r.decision === "allow" && typeof r.commandPrefix === "string"));
  assert.ok(rules.some((r) => r.tool === "bash" && r.commandPrefix === "npm test"));
  assert.ok(rules.some((r) => r.tool === "powershell" && r.commandPrefix === "Get-Process"));
});

test("store: persists a schema version and leaves no temp file (atomic write)", async () => {
  assert.equal(rememberAllowRule("bash", "ls -la"), true);
  const raw = JSON.parse(await fs.readFile(path.join(tmp, "permissions.json"), "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Array.isArray(raw.allow) && raw.allow.some((r: { commandPrefix: string }) => r.commandPrefix === "ls -la"));
  await assert.rejects(fs.stat(path.join(tmp, "permissions.json.tmp"))); // temp file must not linger
});

test("store: an OLD versionless {allow:[…]} file still loads (forward-compat)", async () => {
  await fs.writeFile(
    path.join(tmp, "permissions.json"),
    JSON.stringify({ allow: [{ tool: "bash", commandPrefix: "git status" }] }),
  );
  assert.ok(loadPermissionRules().some((r) => r.commandPrefix === "git status"));
});
