// Auto-tests: the unified event renderer (pure → returns the string to print). Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEvent, type RenderCtx } from "../src/ui/render.ts";
import { makeTheme } from "../src/ui/theme.ts";

const CTX: RenderCtx = { theme: makeTheme(false), cols: 80, markdown: true };

test("assistant: markdown text (non-stream); tool calls; nothing while streaming", () => {
  assert.ok(renderEvent({ type: "assistant", text: "**hi** there", toolCalls: [], turn: 1 }, CTX).includes("hi there"));
  const calls = renderEvent(
    { type: "assistant", text: "", toolCalls: [{ id: "1", function: { name: "read_file", arguments: { path: "a" } } }], turn: 1 },
    CTX,
  );
  assert.ok(calls.includes("→ read_file"));
  assert.equal(renderEvent({ type: "assistant", text: "streamed", toolCalls: [], turn: 1 }, { ...CTX, streaming: true }), "");
});

test("tool_result: one-line summary, or a colorized diff", () => {
  const r = renderEvent({ type: "tool_result", tool: "read_file", decision: "allow", content: "ok done", turn: 1 }, CTX);
  assert.ok(r.includes("↳ [allow] read_file:"));
  const d = renderEvent({ type: "tool_result", tool: "edit", decision: "allow", content: "@@ -1 +1 @@\n-a\n+b", turn: 1 }, CTX);
  assert.ok(d.includes("+b") && d.includes("-a"));
});

test("warning + compaction + context meter", () => {
  assert.ok(renderEvent({ type: "warning", code: "x", message: "watch out", turn: 1 }, CTX).includes("⚠️"));
  assert.ok(renderEvent({ type: "compaction", summarized: 3, turn: 1 }, CTX).includes("compacted context"));
  assert.ok(renderEvent({ type: "context", usedTokens: 80, numCtx: 100, turn: 1 }, CTX).includes("context")); // warn → shown
  assert.equal(renderEvent({ type: "context", usedTokens: 10, numCtx: 100, turn: 1 }, CTX), ""); // quiet when low
});

test("scope prefixes worker lines; done renders nothing", () => {
  const s = renderEvent({ type: "tool_result", tool: "grep", decision: "allow", content: "hit", turn: 1 }, { ...CTX, scope: "w1" });
  assert.ok(s.startsWith("[w1] "));
  assert.equal(renderEvent({ type: "done", reason: "x", turns: 1 }, CTX), "");
});
