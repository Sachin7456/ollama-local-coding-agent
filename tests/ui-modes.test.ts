// Auto-tests: permission-mode cycling (pure).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleMode, MODE_CYCLE } from "../src/ui/modes.ts";
import { permissionChoices } from "../src/ui/permissionDialog.ts";

test("cycleMode rotates the safe trio; bypass falls back to default", () => {
  assert.equal(cycleMode("default"), "acceptEdits");
  assert.equal(cycleMode("acceptEdits"), "plan");
  assert.equal(cycleMode("plan"), "default");
  assert.equal(cycleMode("bypass"), "default"); // outside the cycle → start
  assert.ok(!MODE_CYCLE.includes("bypass")); // bypass is never cycled into
});

test("permissionChoices: allow / always / deny with the tool name", () => {
  const c = permissionChoices("bash");
  assert.deepEqual(c.map((x) => x.value), ["allow", "always", "deny"]);
  assert.ok(c[1].label.includes("bash"));
});
