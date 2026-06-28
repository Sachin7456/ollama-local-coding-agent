// Auto-tests: one-time legacy→per-project migration. Zero deps; a fresh temp QWEN_HARNESS_DIR per test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performStartupMigrations } from "../src/state/migration.ts";
import { projectDir, harnessDir } from "../src/state/session.ts";

let tmp = "";
let cwd = "";
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "qh-mig-"));
  process.env.QWEN_HARNESS_DIR = tmp;
  cwd = path.join(tmp, "proj"); // a stable per-project key
});
afterEach(async () => {
  delete process.env.QWEN_HARNESS_DIR;
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

function writeGlobal(perms: unknown, memLines: string[]): void {
  if (perms !== undefined) fs.writeFileSync(path.join(tmp, "permissions.json"), JSON.stringify(perms), "utf8");
  if (memLines.length) fs.writeFileSync(path.join(tmp, "memory.jsonl"), memLines.join("\n") + "\n", "utf8");
}

test("migrates legacy global approvals + memory into the per-project store", () => {
  writeGlobal(
    { allow: [{ tool: "bash", commandPrefix: "npm test" }, { tool: "powershell", commandPrefix: "Get-Process" }] },
    [JSON.stringify({ text: "the user prefers Hinglish", ts: "2026-06-01T00:00:00Z" })],
  );
  const notice = performStartupMigrations(cwd);
  assert.match(notice, /migrated/);

  const dir = projectDir(cwd);
  const perms = JSON.parse(fs.readFileSync(path.join(dir, "permissions.json"), "utf8"));
  assert.equal(perms.version, 1);
  assert.ok(perms.allow.some((r: { commandPrefix: string }) => r.commandPrefix === "npm test"));

  const mem = fs.readFileSync(path.join(dir, "memory.jsonl"), "utf8");
  assert.match(mem, /prefers Hinglish/);
});

test("is idempotent — a second run is a no-op (manifest-gated)", () => {
  writeGlobal({ allow: [{ tool: "bash", commandPrefix: "ls" }] }, []);
  assert.match(performStartupMigrations(cwd), /migrated/);
  assert.equal(performStartupMigrations(cwd), ""); // already done
  // a manifest exists recording the migration
  assert.ok(fs.existsSync(path.join(tmp, ".migration-manifest.json")));
});

test("fresh install (no legacy files) → no-op, no crash", () => {
  assert.equal(performStartupMigrations(cwd), "");
  assert.ok(fs.existsSync(path.join(tmp, ".migration-manifest.json"))); // marked done so it won't re-check forever
});

test("never overwrites an existing per-project file (fail-safe)", () => {
  writeGlobal({ allow: [{ tool: "bash", commandPrefix: "rm -rf node_modules" }] }, []);
  const dir = projectDir(cwd);
  // a per-project file already exists with different content → migration must NOT clobber it
  fs.writeFileSync(path.join(dir, "permissions.json"), JSON.stringify({ version: 1, allow: [{ tool: "bash", commandPrefix: "git status" }] }), "utf8");
  performStartupMigrations(cwd);
  const perms = JSON.parse(fs.readFileSync(path.join(dir, "permissions.json"), "utf8"));
  assert.ok(perms.allow.some((r: { commandPrefix: string }) => r.commandPrefix === "git status"));
  assert.ok(!perms.allow.some((r: { commandPrefix: string }) => r.commandPrefix === "rm -rf node_modules"));
});
