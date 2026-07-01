// Auto-tests: status line formatting (model · mode · cwd · ctx% · session). Pure + width-aware.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { formatStatusLine, shortCwd, compactTokens, relativeTime } from "../src/ui/statusline.ts";
import { stringWidth } from "../src/ui/width.ts";
import { makeTheme } from "../src/ui/theme.ts";

test("shortCwd: collapses the home prefix to ~", () => {
  const home = path.join(path.sep === "\\" ? "C:\\Users\\u" : "/home/u");
  assert.equal(shortCwd(path.join(home, "proj"), home).startsWith("~"), true);
  assert.equal(shortCwd(path.join(home, "proj"), home).includes("proj"), true);
  assert.equal(shortCwd("/elsewhere/x", home), "/elsewhere/x"); // outside home → unchanged
});

test("status line includes the model and fits the column budget", () => {
  const parts = { model: "qwen2.5-coder:7b", mode: "default", cwd: "/a/b/c", contextPct: 0.8, sessionId: "abcd1234ef" };
  const full = formatStatusLine(parts, 200, makeTheme(false));
  assert.ok(full.includes("qwen2.5-coder:7b") && full.includes("default") && full.includes("ctx 80%"));
  assert.ok(full.includes("sess abcd1234")); // session id truncated to 8
  const narrow = formatStatusLine(parts, 20, makeTheme(false));
  assert.ok(stringWidth(narrow) <= 20); // truncated to fit
});

test("relativeTime: just now / m / h / d ago; invalid → empty", () => {
  const now = Date.parse("2026-07-01T12:00:00Z");
  assert.equal(relativeTime("2026-07-01T11:59:30Z", now), "just now");
  assert.equal(relativeTime("2026-07-01T11:30:00Z", now), "30m ago");
  assert.equal(relativeTime("2026-07-01T09:00:00Z", now), "3h ago");
  assert.equal(relativeTime("2026-06-28T12:00:00Z", now), "3d ago");
  assert.equal(relativeTime("not-a-date", now), "");
});

test("compactTokens: plain under 1k, k/M above", () => {
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(1000), "1k");
  assert.equal(compactTokens(1500), "1.5k");
  assert.equal(compactTokens(1_200_000), "1.2M");
});

test("status line shows the token ↑in ↓out counter when provided", () => {
  const parts = { model: "m", mode: "default", cwd: "/x", tokensIn: 1500, tokensOut: 320 };
  const line = formatStatusLine(parts, 200, makeTheme(false));
  assert.match(line, /↑1\.5k ↓320/);
  const none = formatStatusLine({ model: "m", mode: "default", cwd: "/x" }, 200, makeTheme(false));
  assert.ok(!none.includes("↑")); // omitted when no token counts
});

test("status line themed when color enabled", () => {
  const parts = { model: "m", mode: "plan", cwd: "/x" };
  assert.ok(formatStatusLine(parts, 80, makeTheme(true)).includes("\x1b["));
  assert.ok(!formatStatusLine(parts, 80, makeTheme(false)).includes("\x1b["));
});
