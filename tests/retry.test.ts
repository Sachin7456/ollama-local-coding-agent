// Auto-tests: retryWithBackoff config-guarding (NIT: maxRetries < 0 / NaN must still attempt once). Zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff } from "../src/model/retry.ts";

const FAST = { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 2, factor: 2, jitterRatio: 0 };

test("retryWithBackoff: maxRetries < 0 still attempts ONCE and throws the REAL error (never undefined)", async () => {
  let calls = 0;
  const boom = new Error("real failure");
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw boom; }, undefined, { ...FAST, maxRetries: -1 }),
    (e) => e === boom, // the real error, not `undefined`
  );
  assert.equal(calls, 1);
});

test("retryWithBackoff: NaN maxRetries attempts once", async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw new Error("x"); }, undefined, { ...FAST, maxRetries: NaN }),
    /x/,
  );
  assert.equal(calls, 1);
});

test("retryWithBackoff: maxRetries 0 = exactly one attempt", async () => {
  let calls = 0;
  await assert.rejects(() => retryWithBackoff(async () => { calls++; throw new Error("y"); }, undefined, FAST), /y/);
  assert.equal(calls, 1);
});
