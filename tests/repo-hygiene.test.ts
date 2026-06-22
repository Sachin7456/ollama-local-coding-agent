// Repo-hygiene checks for the public release surface. Zero deps.
// Ensures the documents that ship publicly exist, are non-empty, and state the
// expected rules — so a release can't go out missing its README/CONTRIBUTING/LICENSE.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

test("required public files exist and are non-empty", () => {
  for (const f of [
    "README.md",
    "USER-GUIDE.md",
    "CONTRIBUTING.md",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE",
    ".gitignore",
    ".env.example",
    "package.json",
  ]) {
    assert.ok(exists(f), `${f} should exist`);
    assert.ok(read(f).trim().length > 0, `${f} should not be empty`);
  }
});

test("CONTRIBUTING.md states the core rules", () => {
  const c = read("CONTRIBUTING.md");
  assert.match(c, /Pull Request/i);
  assert.match(c, /\bmain\b/);
  assert.match(c, /maintainer/i);
  assert.match(c, /secret/i); // the "no secrets in a PR" rule
});

test("README points to CONTRIBUTING, LICENSE and THIRD_PARTY_NOTICES", () => {
  const r = read("README.md");
  assert.match(r, /CONTRIBUTING\.md/);
  assert.match(r, /LICENSE/);
  assert.match(r, /THIRD_PARTY_NOTICES\.md/);
});

test("LICENSE is Apache-2.0", () => {
  const license = read("LICENSE");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
});

test("THIRD_PARTY_NOTICES states zero deps + the architecture & layout", () => {
  const t = read("THIRD_PARTY_NOTICES.md");
  assert.match(t, /zero[- ].*dependenc|no third-party/i);
  assert.match(t, /Architecture/i);
  assert.match(t, /Project layout/i);
});
