// Auto-tests: the concurrency gate (Semaphore). Zero deps, pure logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/orchestration/gate.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Semaphore caps concurrency at its capacity (2)", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      sem.withPermit(async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(20);
        running--;
      }),
    ),
  );
  assert.ok(peak <= 2, `observed peak ${peak}, expected <= 2`);
  assert.ok(sem.peakCount <= 2);
  assert.equal(sem.activeCount, 0);
});

test("capacity 1 fully serializes (peak === 1)", async () => {
  const sem = new Semaphore(1);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      sem.withPermit(async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(10);
        running--;
      }),
    ),
  );
  assert.equal(peak, 1);
});

test("withPermit releases even if fn throws", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    () => sem.withPermit(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(sem.activeCount, 0);
  assert.equal(await sem.withPermit(async () => 42), 42); // still usable
});

test("manual acquire returns an idempotent release (double-release is a no-op)", async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  assert.equal(sem.activeCount, 1);
  release();
  release(); // no-op
  assert.equal(sem.activeCount, 0);
});

test("all queued work eventually completes under a cap", async () => {
  const sem = new Semaphore(2);
  const done: number[] = [];
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => sem.withPermit(async () => { await delay(5); done.push(i); })),
  );
  assert.equal(done.length, 10);
});
