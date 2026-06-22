// Auto-tests: multi_edit (atomic batch edits). Zero deps. Real temp dir.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  multiEditTool,
  readFileTool,
  createFullRegistry,
  ReadState,
  type ToolContext,
} from "../src/tools/tools.ts";

let tmp = "";
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qh-m11-"));
});
after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});
function ctxWith(readState?: ReadState): ToolContext {
  return { cwd: tmp, readState };
}

test("multi_edit applies sequential edits and writes once", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "a.txt"), "one two three");
  await readFileTool.execute({ path: "a.txt" }, ctxWith(rs));
  const out = await multiEditTool.execute(
    {
      path: "a.txt",
      edits: [
        { old_string: "one", new_string: "1" },
        { old_string: "1 two", new_string: "1-2" }, // sees the prior edit's result
      ],
    },
    ctxWith(rs),
  );
  assert.match(out, /2 edits applied/);
  assert.equal(await fs.readFile(path.join(tmp, "a.txt"), "utf8"), "1-2 three");
});

test("multi_edit is all-or-nothing: a failing edit aborts with no partial write", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "b.txt"), "hello world");
  await readFileTool.execute({ path: "b.txt" }, ctxWith(rs));
  const out = await multiEditTool.execute(
    {
      path: "b.txt",
      edits: [
        { old_string: "hello", new_string: "hi" },
        { old_string: "NOPE", new_string: "x" }, // fails -> whole batch aborts
      ],
    },
    ctxWith(rs),
  );
  assert.match(out, /not found/i);
  assert.equal(await fs.readFile(path.join(tmp, "b.txt"), "utf8"), "hello world"); // unchanged
});

test("multi_edit enforces read-before-edit once", async () => {
  await fs.writeFile(path.join(tmp, "c.txt"), "abc");
  const rs = new ReadState(); // never read
  const out = await multiEditTool.execute({ path: "c.txt", edits: [{ old_string: "a", new_string: "A" }] }, ctxWith(rs));
  assert.match(out, /must read/i);
  assert.equal(await fs.readFile(path.join(tmp, "c.txt"), "utf8"), "abc");
});

test("multi_edit detects a stale read", async () => {
  await fs.writeFile(path.join(tmp, "d.txt"), "data");
  const rs = new ReadState();
  rs.markRead(path.resolve(tmp, "d.txt"), 1); // pretend read long ago
  const out = await multiEditTool.execute({ path: "d.txt", edits: [{ old_string: "data", new_string: "DATA" }] }, ctxWith(rs));
  assert.match(out, /changed since/i);
});

test("multi_edit rejects an empty edits array", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "e.txt"), "x");
  await readFileTool.execute({ path: "e.txt" }, ctxWith(rs));
  const out = await multiEditTool.execute({ path: "e.txt", edits: [] }, ctxWith(rs));
  assert.match(out, /non-empty array/);
});

test("multi_edit rejects a non-unique old_string unless replace_all", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "f.txt"), "a a a");
  await readFileTool.execute({ path: "f.txt" }, ctxWith(rs));
  const fail = await multiEditTool.execute({ path: "f.txt", edits: [{ old_string: "a", new_string: "b" }] }, ctxWith(rs));
  assert.match(fail, /appears 3 times|make it unique/);
  assert.equal(await fs.readFile(path.join(tmp, "f.txt"), "utf8"), "a a a"); // aborted
});

test("multi_edit supports replace_all per edit", async () => {
  const rs = new ReadState();
  await fs.writeFile(path.join(tmp, "g.txt"), "a a a");
  await readFileTool.execute({ path: "g.txt" }, ctxWith(rs));
  const out = await multiEditTool.execute(
    { path: "g.txt", edits: [{ old_string: "a", new_string: "b", replace_all: true }] },
    ctxWith(rs),
  );
  assert.match(out, /3 replacements/);
  assert.equal(await fs.readFile(path.join(tmp, "g.txt"), "utf8"), "b b b");
});

test("createFullRegistry includes multi_edit (readOnly:false)", () => {
  const reg = createFullRegistry();
  assert.ok(reg.has("multi_edit"));
  assert.equal(reg.get("multi_edit")?.readOnly, false);
});
