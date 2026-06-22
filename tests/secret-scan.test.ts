// MANDATORY secret scan — runs on every `npm test`.
// Zero-dep, built-in scanner: scans the PUBLISHABLE SURFACE and FAILS the suite if any
// high-signal secret pattern is found, so a key can never slip into a release.
// (For a deeper history scan, also run `npm run gitleaks` if you have gitleaks.)
//
// The publishable surface = files git tracks or would add, EXCLUDING anything ignored
// (via .gitignore or git's local excludes). We derive it from `git ls-files` so the
// scanner never has to hard-code which directories are local-only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

// Generic, non-revealing skips for the fallback walk only (used when git is unavailable).
const SKIP_DIRS = new Set(["node_modules", ".git", ".qwen-harness"]);
// This scanner contains the patterns themselves; .env.example documents key NAMES.
const SKIP_FILES = new Set(["secret-scan.test.ts", ".env.example"]);

const NULL_BYTE = String.fromCharCode(0);

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "LLM provider key (sk-)", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "LLM provider key (sk-ant-)", re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "hard-coded secret assignment",
    re: /\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(path.join(dir, entry.name));
    }
  }
}

// Files that would actually be published: tracked + untracked-but-not-ignored.
// Respects .gitignore AND git's local excludes, so local-only files are skipped
// without this test ever naming them. Falls back to a generic walk if git is absent.
function publishableFiles(): string[] {
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard -z", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const rels = out.split(NULL_BYTE).filter(Boolean);
    if (rels.length > 0) {
      return rels.filter((r) => !SKIP_FILES.has(path.basename(r))).map((r) => path.join(ROOT, r));
    }
  } catch {
    /* not a git repo / git unavailable — fall back below */
  }
  const files: string[] = [];
  walk(ROOT, files);
  return files;
}

test("no secrets in the publishable surface", () => {
  const violations: string[] = [];
  for (const file of publishableFiles()) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > 2_000_000) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes(NULL_BYTE)) continue; // binary
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(lines[i])) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1} — possible ${name}`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `Potential secrets found:\n${violations.join("\n")}`);
});

test(".gitignore guards secret files (so they can't be committed)", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  for (const needle of [".env", "*.pem", "*.key", "credentials.json"]) {
    assert.ok(gi.includes(needle), `.gitignore must ignore ${needle}`);
  }
});

test("no real secret files are present in the publishable surface", () => {
  const offenders = publishableFiles()
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => {
      const base = path.basename(rel);
      return (
        base === ".env" ||
        base === "credentials.json" ||
        base.endsWith(".pem") ||
        base.endsWith(".key")
      );
    });
  assert.deepEqual(offenders, [], `Secret-bearing files should not exist here:\n${offenders.join("\n")}`);
});
