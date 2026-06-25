// Auto-tests: tool registry + read_file + grep.
// Zero deps. Uses a real temp directory (node:fs) — NO model is involved.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDefaultRegistry,
  ToolRegistry,
  readFileTool,
  grepTool,
  findFilesTool,
  patternToRegExp,
  FIND_FILES_MAX_RESULTS,
  type ToolContext,
} from "../src/tools/tools.ts";

let tmp = "";
let ctx: ToolContext;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m2-"));
  ctx = { cwd: tmp };
  await fs.writeFile(path.join(tmp, "a.txt"), "alpha\nneedle here\ngamma\n");
  await fs.mkdir(path.join(tmp, "sub"));
  await fs.writeFile(path.join(tmp, "sub", "b.ts"), "const x = 1;\n// needle\n// Needle upper\n");
  await fs.writeFile(path.join(tmp, "empty.txt"), "");
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------- read_file ----------------
test("read_file returns 1-based line-numbered content", async () => {
  const out = await readFileTool.execute({ path: "a.txt" }, ctx);
  assert.match(out, /^\s+1\talpha$/m);
  assert.match(out, /^\s+2\tneedle here$/m);
});

test("read_file honors offset + limit", async () => {
  const out = await readFileTool.execute({ path: "a.txt", offset: 2, limit: 1 }, ctx);
  assert.match(out, /2\tneedle here/);
  assert.doesNotMatch(out, /alpha/);
});

test("read_file reports a missing file as an error string", async () => {
  const out = await readFileTool.execute({ path: "nope.txt" }, ctx);
  assert.match(out, /file not found/);
});

test("read_file handles an empty file", async () => {
  const out = await readFileTool.execute({ path: "empty.txt" }, ctx);
  assert.equal(out, "(empty file)");
});

// ---------------- grep ----------------
test("grep finds matches across a recursive directory with path:line", async () => {
  const out = await grepTool.execute({ pattern: "needle" }, ctx);
  assert.match(out, /a\.txt:2:/);
  assert.match(out, /sub[\\/]b\.ts:2:/);
});

test("grep is case-sensitive by default, case-insensitive on request", async () => {
  const sensitive = await grepTool.execute({ pattern: "Needle" }, ctx);
  assert.match(sensitive, /b\.ts:3:/);
  assert.doesNotMatch(sensitive, /:2:/);
  const insensitive = await grepTool.execute({ pattern: "needle", ignoreCase: true }, ctx);
  assert.match(insensitive, /b\.ts:2:/);
  assert.match(insensitive, /b\.ts:3:/);
});

test("grep caps results with maxResults", async () => {
  const out = await grepTool.execute({ pattern: "needle", ignoreCase: true, maxResults: 1 }, ctx);
  const hits = out.split("\n").filter((l) => /:\d+:/.test(l));
  assert.equal(hits.length, 1);
  assert.match(out, /stopped at 1 matches/);
});

test("grep returns a no-match message and an invalid-regex error", async () => {
  assert.match(await grepTool.execute({ pattern: "zzz_nomatch" }, ctx), /No matches/);
  assert.match(await grepTool.execute({ pattern: "(" }, ctx), /invalid regular expression/);
});

// ---------------- registry ----------------
test("default registry exposes read_file + grep + find_files, all read-only", () => {
  const reg = createDefaultRegistry();
  assert.ok(reg.has("read_file") && reg.has("grep") && reg.has("find_files"));
  assert.equal(reg.get("read_file")?.readOnly, true);
  assert.equal(reg.get("grep")?.readOnly, true);
  assert.equal(reg.get("find_files")?.readOnly, true);
});

test("toToolDefs produces wire-format schemas and can filter by name", () => {
  const reg = createDefaultRegistry();
  const all = reg.toToolDefs();
  assert.equal(all.length, 3);
  for (const d of all) {
    assert.equal(d.type, "function");
    assert.ok(d.function.name.length > 0);
    assert.equal((d.function.parameters as { type?: string }).type, "object");
  }
  const onlyGrep = reg.toToolDefs(["grep"]);
  assert.equal(onlyGrep.length, 1);
  assert.equal(onlyGrep[0].function.name, "grep");
});

test("registry rejects duplicates and dispatches unknown tools as errors", async () => {
  const reg = new ToolRegistry().register(readFileTool);
  assert.throws(() => reg.register(readFileTool), /already registered/);
  const out = await reg.dispatch("does_not_exist", {}, ctx);
  assert.match(out, /unknown tool/);
});

test("read_file on a directory returns a guiding error (use bash ls)", async () => {
  assert.match(await readFileTool.execute({ path: "sub" }, ctx), /is a directory — use bash/);
});

// ---------------- find_files ----------------
test("find_files metadata: read-only, pattern required", () => {
  assert.equal(findFilesTool.name, "find_files");
  assert.equal(findFilesTool.readOnly, true);
  const params = findFilesTool.parameters as { required?: string[] };
  assert.ok((params.required ?? []).includes("pattern"));
});

test("find_files: *.txt is top-level only; **/*.ts matches nested", async () => {
  const top = await findFilesTool.execute({ pattern: "*.txt" }, ctx);
  assert.match(top, /^a\.txt$/m);
  assert.match(top, /^empty\.txt$/m);
  assert.doesNotMatch(top, /b\.ts/); // * does not cross a directory boundary
  assert.match(await findFilesTool.execute({ pattern: "**/*.ts" }, ctx), /sub\/b\.ts/);
});

test("find_files: directory-prefix pattern + path param", async () => {
  assert.match(await findFilesTool.execute({ pattern: "sub/**" }, ctx), /sub\/b\.ts/);
  assert.match(await findFilesTool.execute({ pattern: "*.ts", path: "sub" }, ctx), /^b\.ts$/m);
});

test("find_files: no match + skips node_modules/hidden", async () => {
  assert.match(await findFilesTool.execute({ pattern: "*.md" }, ctx), /No files match/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-ff-"));
  const c: ToolContext = { cwd: dir };
  await fs.writeFile(path.join(dir, "keep.js"), "x");
  await fs.mkdir(path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "node_modules", "junk.js"), "x");
  await fs.writeFile(path.join(dir, ".secret.js"), "x");
  try {
    const out = await findFilesTool.execute({ pattern: "**/*.js" }, c);
    assert.match(out, /keep\.js/);
    assert.doesNotMatch(out, /junk\.js/);
    assert.doesNotMatch(out, /\.secret/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("find_files: caps the listing and notes truncation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-ff-cap-"));
  for (let i = 0; i < FIND_FILES_MAX_RESULTS + 5; i++) await fs.writeFile(path.join(dir, `f${i}.log`), "x");
  try {
    const out = await findFilesTool.execute({ pattern: "*.log" }, { cwd: dir });
    assert.match(out, /more; showing the first 100/);
    assert.equal(out.split("\n").filter((l) => l.endsWith(".log")).length, FIND_FILES_MAX_RESULTS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("patternToRegExp: segment-aware glob → regex (no extglob)", () => {
  assert.ok(patternToRegExp("*.ts").test("a.ts"));
  assert.ok(!patternToRegExp("*.ts").test("sub/a.ts")); // * stays within one segment
  assert.ok(patternToRegExp("**/*.ts").test("sub/a.ts"));
  assert.ok(patternToRegExp("**/*.ts").test("a.ts"));
  assert.ok(patternToRegExp("src/**").test("src/x/y.ts"));
  assert.ok(patternToRegExp("a?c.txt").test("abc.txt"));
  assert.ok(!patternToRegExp("a?c.txt").test("a/c.txt")); // ? is not a slash
  assert.ok(patternToRegExp("{a,b}.txt").test("b.txt"));
  assert.ok(!patternToRegExp("{a,b}.txt").test("c.txt"));
  assert.ok(patternToRegExp("[ab].txt").test("a.txt"));
});

test("registry.dispatch runs a real tool end-to-end", async () => {
  const reg = createDefaultRegistry();
  const out = await reg.dispatch("read_file", { path: "a.txt" }, ctx);
  assert.match(out, /needle here/);
});

// ---------------- grep: bounded-parallel scan (faster, same output) ----------------
test("grep parallel scan is deterministic and order-stable", async () => {
  const a = await grepTool.execute({ pattern: "needle", ignoreCase: true }, ctx);
  const b = await grepTool.execute({ pattern: "needle", ignoreCase: true }, ctx);
  assert.equal(a, b); // identical across runs
  assert.match(a, /a\.txt:2:/);
  assert.match(a, /b\.ts:2:/);
  assert.match(a, /b\.ts:3:/);
});

test("grep parallel scan honors maxResults exactly", async () => {
  const out = await grepTool.execute({ pattern: "needle", ignoreCase: true, maxResults: 2 }, ctx);
  const hits = out.split("\n").filter((l) => /:\d+:/.test(l));
  assert.equal(hits.length, 2);
  assert.match(out, /stopped at 2 matches/);
});

test("grep skips binary files", async () => {
  await fs.writeFile(path.join(tmp, "bin.dat"), `needle${String.fromCharCode(0)}needle\n`);
  const out = await grepTool.execute({ pattern: "needle", ignoreCase: true }, ctx);
  assert.doesNotMatch(out, /bin\.dat/); // NUL byte => treated as binary, skipped
});
