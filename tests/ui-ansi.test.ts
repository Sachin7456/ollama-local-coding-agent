// Auto-tests: ANSI capability gate + Style + Theme. Zero deps; pure functions, no terminal needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorEnabled, makeStyle } from "../src/ui/ansi.ts";
import { makeTheme } from "../src/ui/theme.ts";

test("colorEnabled: pref wins first (never/always)", () => {
  assert.equal(colorEnabled({ pref: "never", isTTY: true, hasColors: true }), false);
  assert.equal(colorEnabled({ pref: "always", isTTY: false }), true);
});

test("colorEnabled: NO_COLOR / NODE_DISABLE_COLORS disable; FORCE_COLOR overrides", () => {
  assert.equal(colorEnabled({ isTTY: true, hasColors: true, env: { NO_COLOR: "" } }), false); // presence disables
  assert.equal(colorEnabled({ isTTY: true, hasColors: true, env: { NODE_DISABLE_COLORS: "1" } }), false);
  assert.equal(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } }), true);
  assert.equal(colorEnabled({ isTTY: true, hasColors: true, env: { FORCE_COLOR: "0" } }), false);
});

test("colorEnabled: auto needs a TTY that reports color", () => {
  assert.equal(colorEnabled({ isTTY: true, hasColors: true, env: {} }), true);
  assert.equal(colorEnabled({ isTTY: false, env: {} }), false); // piped
  assert.equal(colorEnabled({ isTTY: true, hasColors: false, env: {} }), false); // dumb terminal
});

test("makeStyle(false) is all identity — no escape codes ever", () => {
  const s = makeStyle(false);
  assert.equal(s.red("x"), "x");
  assert.equal(s.bold("y"), "y");
  assert.ok(!s.green("z").includes("\x1b"));
});

test("makeStyle(true) wraps with SGR codes + resets", () => {
  const s = makeStyle(true);
  const red = s.red("x");
  assert.ok(red.includes("\x1b[31m") && red.includes("\x1b[39m") && red.includes("x"));
  assert.ok(s.bold("x").includes("\x1b[1m"));
});

test("theme: roles are identity when disabled, styled when enabled", () => {
  const off = makeTheme(false);
  assert.equal(off.warn("hi"), "hi");
  assert.equal(off.diffAdd("+a"), "+a");
  const on = makeTheme(true);
  assert.ok(on.warn("hi").includes("\x1b["));
  assert.ok(on.accent("h").includes("\x1b[")); // bold+cyan
});
