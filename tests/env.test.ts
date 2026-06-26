// Tests the zero-dep .env parser. Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDotEnv, loadDotEnv } from "../src/cli/loadEnv.ts";

test("parses KEY=VALUE pairs", () => {
  const out = parseDotEnv("OLLAMA_BASE_URL=http://127.0.0.1:11434\nHARNESS_MODEL=qwen2.5-coder:7b");
  assert.equal(out.OLLAMA_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(out.HARNESS_MODEL, "qwen2.5-coder:7b");
});

test("ignores blank lines and # comments", () => {
  const out = parseDotEnv("# a comment\n\n  # indented comment\nA=1\n");
  assert.deepEqual(out, { A: "1" });
});

test("strips surrounding single/double quotes", () => {
  const out = parseDotEnv(`A="quoted value"\nB='single'`);
  assert.equal(out.A, "quoted value");
  assert.equal(out.B, "single");
});

test("keeps '=' that appear in the value", () => {
  const out = parseDotEnv("URL=http://x/?a=1&b=2");
  assert.equal(out.URL, "http://x/?a=1&b=2");
});

test("skips lines without '=' and trims whitespace", () => {
  const out = parseDotEnv("not_a_pair\n  KEY  =  val  ");
  assert.deepEqual(out, { KEY: "val" });
});

test("strips an inline # comment on an unquoted value (B7)", () => {
  const out = parseDotEnv("HARNESS_MODEL=qwen2.5-coder:7b # default model\nB=plain");
  assert.equal(out.HARNESS_MODEL, "qwen2.5-coder:7b");
  assert.equal(out.B, "plain");
});

test("does not strip a # inside quotes, and keeps a # with no leading space (B7)", () => {
  assert.equal(parseDotEnv(`A="a # b"`).A, "a # b");
  assert.equal(parseDotEnv("P=pa#ss").P, "pa#ss"); // no space before # → part of the value
});

test("handles a shell-style `export ` prefix on the key (B7)", () => {
  const out = parseDotEnv("export FOO=bar");
  assert.equal(out.FOO, "bar");
  assert.equal(out["export FOO"], undefined);
});

test("loadDotEnv: an empty value (KEY=) is treated as UNSET — so defaults still apply", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qh-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "QH_TEST_EMPTY=\nQH_TEST_SET=hello\n");
  delete process.env.QH_TEST_EMPTY;
  delete process.env.QH_TEST_SET;
  loadDotEnv(file);
  assert.equal(process.env.QH_TEST_EMPTY, undefined); // empty → not written, so `?? default` works
  assert.equal(process.env.QH_TEST_SET, "hello"); // non-empty → applied
  delete process.env.QH_TEST_EMPTY;
  delete process.env.QH_TEST_SET;
});
