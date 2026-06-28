// Auto-tests: REPL helpers. Zero deps, pure logic, no model/readline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { interruptAction, shellGuidance, parseAskReply, runLines } from "../src/cli/repl.ts";

// a tiny async-iterable of lines (stands in for piped readline input)
async function* lines(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x;
}

test("interruptAction: cancel while a task runs, exit when idle", () => {
  assert.equal(interruptAction(true), "cancel");
  assert.equal(interruptAction(false), "exit");
});

test("shellGuidance: powershell on Windows, bash elsewhere", () => {
  assert.match(shellGuidance("win32"), /powershell/i);
  assert.match(shellGuidance("win32"), /Get-Process/);
  assert.match(shellGuidance("linux"), /bash/i);
  assert.match(shellGuidance("darwin"), /bash/i);
});

test("parseAskReply: y/yes → once, a/always → always, else → no", () => {
  assert.equal(parseAskReply("y"), "once");
  assert.equal(parseAskReply("yes"), "once");
  assert.equal(parseAskReply("a"), "always");
  assert.equal(parseAskReply("ALWAYS"), "always");
  assert.equal(parseAskReply("n"), "no");
  assert.equal(parseAskReply(""), "no");
  assert.equal(parseAskReply("nonsense"), "no");
});

test("runLines: processes EVERY line in order (no drops), trimming each", async () => {
  const seen: string[] = [];
  await runLines(lines("  task one  ", "task two", "", "task three"), async (l) => {
    seen.push(l);
    return true;
  });
  assert.deepEqual(seen, ["task one", "task two", "", "task three"]); // all lines, in order, trimmed
});

test("runLines: stops as soon as the handler returns false (e.g. /exit)", async () => {
  const seen: string[] = [];
  await runLines(lines("a", "/exit", "b", "c"), async (l) => {
    seen.push(l);
    return l !== "/exit";
  });
  assert.deepEqual(seen, ["a", "/exit"]); // stopped at /exit; "b"/"c" never processed
});

test("runLines: awaits each line before the next (sequential, not interleaved)", async () => {
  const order: string[] = [];
  await runLines(lines("1", "2"), async (l) => {
    order.push(`start ${l}`);
    await Promise.resolve();
    order.push(`end ${l}`);
    return true;
  });
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]); // line 1 fully done before line 2 starts
});
