// Auto-tests: write_file, edit_file (exact-match + read-before-edit), bash.
// Zero deps. Uses a real temp dir. The bash test runs a harmless `echo`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeFileTool,
  editFileTool,
  bashTool,
  readFileTool,
  createFullRegistry,
  ReadState,
  type ToolContext,
} from "../src/tools/tools.ts";

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m5-"));
});
after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});
function ctxWith(readState?: ReadState): ToolContext {
  return { cwd: tmp, readState };
}

// ---------------- write_file ----------------
test("write_file creates a file and its parent dirs", async () => {
  const out = await writeFileTool.execute({ path: "sub/dir/new.txt", content: "hello" }, ctxWith());
  assert.match(out, /Wrote 5 bytes/);
  assert.equal(await fs.readFile(path.join(tmp, "sub/dir/new.txt"), "utf8"), "hello");
});

test("write_file overwrites existing content", async () => {
  await writeFileTool.execute({ path: "o.txt", content: "one" }, ctxWith());
  await writeFileTool.execute({ path: "o.txt", content: "two" }, ctxWith());
  assert.equal(await fs.readFile(path.join(tmp, "o.txt"), "utf8"), "two");
});

// ---------------- edit_file ----------------
test("edit_file replaces a unique substring (after a read)", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "e.txt"), "alpha beta gamma");
  await readFileTool.execute({ path: "e.txt" }, ctxWith(rs)); // marks read
  const out = await editFileTool.execute({ path: "e.txt", old_string: "beta", new_string: "BETA" }, ctxWith(rs));
  assert.match(out, /1 replacement/);
  assert.equal(await fs.readFile(path.join(tmp, "e.txt"), "utf8"), "alpha BETA gamma");
});

test("edit_file enforces read-before-edit", async () => {
  await fs.writeFile(path.join(tmp, "r.txt"), "x y z");
  const rs = new ReadState(); // never read
  const out = await editFileTool.execute({ path: "r.txt", old_string: "y", new_string: "Y" }, ctxWith(rs));
  assert.match(out, /must read/i);
  assert.equal(await fs.readFile(path.join(tmp, "r.txt"), "utf8"), "x y z"); // unchanged
});

test("edit_file refuses a non-unique old_string unless replace_all", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "dup.txt"), "a a a");
  await readFileTool.execute({ path: "dup.txt" }, ctxWith(rs));
  const fail = await editFileTool.execute({ path: "dup.txt", old_string: "a", new_string: "b" }, ctxWith(rs));
  assert.match(fail, /unique|appears 3 times/);
  const ok = await editFileTool.execute(
    { path: "dup.txt", old_string: "a", new_string: "b", replace_all: true },
    ctxWith(rs),
  );
  assert.match(ok, /3 replacements/);
  assert.equal(await fs.readFile(path.join(tmp, "dup.txt"), "utf8"), "b b b");
});

test("edit_file errors when old_string is not found", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "nf.txt"), "hello");
  await readFileTool.execute({ path: "nf.txt" }, ctxWith(rs));
  assert.match(await editFileTool.execute({ path: "nf.txt", old_string: "zzz", new_string: "q" }, ctxWith(rs)), /not found/);
});

test("edit_file detects a stale read", async () => {
  await fs.writeFile(path.join(tmp, "st.txt"), "data here");
  const rs = new ReadState();
  rs.markRead(path.resolve(tmp, "st.txt"), 1); // pretend we read it long ago
  assert.match(
    await editFileTool.execute({ path: "st.txt", old_string: "data", new_string: "DATA" }, ctxWith(rs)),
    /changed since/i,
  );
});

test("edit_file rejects empty old_string and no-op edits", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "g.txt"), "abc");
  await readFileTool.execute({ path: "g.txt" }, ctxWith(rs));
  assert.match(await editFileTool.execute({ path: "g.txt", old_string: "", new_string: "x" }, ctxWith(rs)), /non-empty/);
  assert.match(await editFileTool.execute({ path: "g.txt", old_string: "abc", new_string: "abc" }, ctxWith(rs)), /identical/);
});

// ---------------- bash ----------------
test("bash runs a harmless command and returns output + exit code", async () => {
  const out = await bashTool.execute({ command: "echo hello_harness" }, ctxWith());
  assert.match(out, /exit code: 0/);
  assert.match(out, /hello_harness/);
});

// ---------------- edit_file whitespace-tolerant fallback ----------------
test("edit_file falls back to a whitespace-tolerant match when exact fails (unique)", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "ws.txt"), "function foo() {\n        return 1;\n}\n");
  await readFileTool.execute({ path: "ws.txt" }, ctxWith(rs));
  // old_string's indentation differs from the file (no exact substring match)
  const out = await editFileTool.execute(
    { path: "ws.txt", old_string: "function foo() {\nreturn 1;", new_string: "function foo() {\n    return 2;" },
    ctxWith(rs),
  );
  assert.match(out, /ignoring whitespace/);
  const after = await fs.readFile(path.join(tmp, "ws.txt"), "utf8");
  assert.match(after, /return 2;/);
  assert.doesNotMatch(after, /return 1;/);
});

test("edit_file whitespace-tolerant fallback refuses an ambiguous match", async () => {
  const rs = new ReadState();
  const content = "if (a) {\n\t\tdo();\n}\nif (a) {\n    do();\n}\n";
  await fs.writeFile(path.join(tmp, "amb.txt"), content);
  await readFileTool.execute({ path: "amb.txt" }, ctxWith(rs));
  const out = await editFileTool.execute(
    { path: "amb.txt", old_string: "if (a) {\ndo();\n}", new_string: "if (a) {\n  done();\n}" },
    ctxWith(rs),
  );
  assert.match(out, /ambiguous/i);
  assert.equal(await fs.readFile(path.join(tmp, "amb.txt"), "utf8"), content); // unchanged
});

test("edit_file whitespace-tolerant fallback still enforces read-before-edit", async () => {
  await fs.writeFile(path.join(tmp, "wsr.txt"), "x\n        y\n");
  const rs = new ReadState(); // never read
  const out = await editFileTool.execute({ path: "wsr.txt", old_string: "x\ny", new_string: "x\nY" }, ctxWith(rs));
  assert.match(out, /must read/i);
});

test("edit_file whitespace-tolerant fallback respects staleness", async () => {
  await fs.writeFile(path.join(tmp, "wss.txt"), "a\n        b\n");
  const rs = new ReadState();
  rs.markRead(path.resolve(tmp, "wss.txt"), 1); // stale read
  const out = await editFileTool.execute({ path: "wss.txt", old_string: "a\nb", new_string: "a\nB" }, ctxWith(rs));
  assert.match(out, /changed since/i);
});

test("edit_file prefers an exact match over the whitespace-tolerant fallback", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "exact.txt"), "alpha beta gamma");
  await readFileTool.execute({ path: "exact.txt" }, ctxWith(rs));
  const out = await editFileTool.execute({ path: "exact.txt", old_string: "beta", new_string: "BETA" }, ctxWith(rs));
  assert.match(out, /1 replacement/);
  assert.doesNotMatch(out, /ignoring whitespace/);
  assert.equal(await fs.readFile(path.join(tmp, "exact.txt"), "utf8"), "alpha BETA gamma");
});

// ---------------- registry ----------------
test("createFullRegistry includes the mutating tools (all readOnly:false)", () => {
  const reg = createFullRegistry();
  for (const n of ["read_file", "grep", "write_file", "edit_file", "multi_edit", "bash"]) assert.ok(reg.has(n), n);
  assert.equal(reg.get("write_file")?.readOnly, false);
  assert.equal(reg.get("edit_file")?.readOnly, false);
  assert.equal(reg.get("bash")?.readOnly, false);
});
