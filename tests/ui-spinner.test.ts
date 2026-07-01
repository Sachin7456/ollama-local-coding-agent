// Auto-tests: spinner formatting + pause-aware elapsed timer (pure). Clock injected (no real time).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spinnerFrame, formatElapsed, formatSpinner, ElapsedTimer, SPINNER_FRAMES } from "../src/ui/spinner.ts";
import { makeTheme } from "../src/ui/theme.ts";
import type { Clock } from "../src/ui/io.ts";

test("spinnerFrame cycles through the frames", () => {
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(1), SPINNER_FRAMES[1]);
});

test("formatElapsed: seconds then m:ss", () => {
  assert.equal(formatElapsed(5000), "5s");
  assert.equal(formatElapsed(65000), "1m05s");
});

test("formatSpinner shows verb + elapsed; themed adds ANSI", () => {
  const line = { verb: "thinking", elapsedMs: 3000, tokens: 42 };
  const plain = formatSpinner(0, line, makeTheme(false));
  assert.ok(plain.includes("thinking") && plain.includes("3s") && plain.includes("42 tok"));
  assert.ok(formatSpinner(0, line, makeTheme(true)).includes("\x1b["));
});

test("ElapsedTimer excludes paused time", () => {
  let t = 0;
  const clock: Clock = { now: () => t };
  const timer = new ElapsedTimer(clock);
  t = 5000;
  assert.equal(timer.elapsed(), 5000);
  timer.pause();
  t = 8000; // 3s paused
  assert.equal(timer.elapsed(), 5000); // frozen while paused
  timer.resume();
  t = 10000;
  assert.equal(timer.elapsed(), 7000); // 10s wall − 3s paused
});
