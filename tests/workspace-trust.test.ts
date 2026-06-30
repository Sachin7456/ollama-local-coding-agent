// Auto-tests: per-project, content-addressed workspace-trust store (Help004 / A2). Zero deps; temp QWEN_HARNESS_DIR.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTrustDecision, storeTrustDecision, isWorkspaceTrusted } from "../src/permissions/workspaceTrust.ts";
import { projectDir, projectKey } from "../src/state/session.ts";
import { projectRulesIdentity } from "../src/state/projectRules.ts";

let tmp = "";
let cwd = "";
const saved = process.env.QWEN_HARNESS_DIR;
const idA = { name: "AGENTS.md", hash: "h1" };
const idA2 = { name: "AGENTS.md", hash: "h2" }; // same file, changed content
const idB = { name: ".qwenrules", hash: "h1" }; // different file (same hash string)

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-trust-"));
  process.env.QWEN_HARNESS_DIR = tmp;
  cwd = path.join(tmp, "proj");
});

after(async () => {
  if (saved === undefined) delete process.env.QWEN_HARNESS_DIR;
  else process.env.QWEN_HARNESS_DIR = saved;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("no decision on record → null / not trusted (fail-safe)", () => {
  assert.equal(readTrustDecision(cwd, idA), null);
  assert.equal(isWorkspaceTrusted(cwd, idA), false);
});

test("round-trips true/false for the SAME rules identity", () => {
  assert.equal(storeTrustDecision(cwd, true, idA), true);
  assert.equal(readTrustDecision(cwd, idA), true);
  assert.equal(isWorkspaceTrusted(cwd, idA), true);
  assert.equal(storeTrustDecision(cwd, false, idA), true);
  assert.equal(readTrustDecision(cwd, idA), false);
  assert.equal(isWorkspaceTrusted(cwd, idA), false); // an explicit "false" is NOT trusted
});

test("persists version 2 + identity + decidedAt, no temp file (atomic)", async () => {
  storeTrustDecision(cwd, true, idA);
  const dir = projectDir(cwd);
  const raw = JSON.parse(await fs.readFile(path.join(dir, "trust.json"), "utf8"));
  assert.equal(raw.version, 2);
  assert.equal(raw.trusted, true);
  assert.equal(raw.rulesFile, "AGENTS.md");
  assert.equal(raw.rulesHash, "h1");
  assert.equal(typeof raw.decidedAt, "string");
  await assert.rejects(fs.stat(path.join(dir, "trust.json.tmp")));
});

test("A2: a changed hash or a different file → null (re-prompt)", () => {
  storeTrustDecision(cwd, true, idA);
  assert.equal(readTrustDecision(cwd, idA), true); // same identity → honoured
  assert.equal(readTrustDecision(cwd, idA2), null); // content changed (h1→h2) → re-prompt
  assert.equal(readTrustDecision(cwd, idB), null); // a different file wins precedence → re-prompt
  assert.equal(readTrustDecision(cwd, null), null); // no rules file now → re-prompt
});

test("A2: a legacy v1 record (no identity) → null (one-time re-prompt = migration)", async () => {
  const proj = path.join(tmp, "legacy");
  const dir = projectDir(proj);
  await fs.writeFile(path.join(dir, "trust.json"), JSON.stringify({ version: 1, trusted: true }));
  assert.equal(readTrustDecision(proj, idA), null);
});

test("trust is PER-PROJECT (a decision in A doesn't apply in B)", () => {
  const projA = path.join(tmp, "alpha");
  const projB = path.join(tmp, "beta");
  storeTrustDecision(projA, true, idA);
  assert.equal(isWorkspaceTrusted(projA, idA), true);
  assert.equal(readTrustDecision(projB, idA), null); // isolated — no carry-over
});

test("A2 monorepo: shared git root → shared store, but a different subfolder rules file re-prompts", async () => {
  const repo = path.join(tmp, "repo");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  const subA = path.join(repo, "subA");
  const subB = path.join(repo, "subB");
  await fs.mkdir(subA, { recursive: true });
  await fs.mkdir(subB, { recursive: true });
  await fs.writeFile(path.join(subA, "AGENTS.md"), "rules A");
  await fs.writeFile(path.join(subB, "AGENTS.md"), "rules B (different)");
  assert.equal(projectKey(subA), projectKey(subB)); // same repo root → SAME trust store (the bug's precondition)
  const ida = projectRulesIdentity(subA)!;
  storeTrustDecision(subA, true, ida); // trust subA's rules
  assert.equal(readTrustDecision(subA, ida), true);
  const idb = projectRulesIdentity(subB)!;
  assert.equal(readTrustDecision(subB, idb), null); // subB's different rules are NOT auto-trusted (the A2 fix)
});

test("storeTrustDecision: returns false and leaves no temp file when the rename fails", async () => {
  const proj = path.join(tmp, "rofs"); // a fresh project so it doesn't collide with the others
  const dir = projectDir(proj);
  await fs.mkdir(path.join(dir, "trust.json")); // destination is a DIRECTORY → renameSync(tmp -> trust.json) throws
  assert.equal(storeTrustDecision(proj, true, idA), false);
  await assert.rejects(fs.stat(path.join(dir, "trust.json.tmp"))); // the half-written temp file was cleaned up
});
