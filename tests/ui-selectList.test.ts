// Auto-tests: the pure filter-and-select list reducer + renderer. No terminal — plain Key objects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeList, filtered, applyKey, renderList, type ListState } from "../src/ui/selectList.ts";
import { makeTheme } from "../src/ui/theme.ts";
import type { Key } from "../src/ui/io.ts";

const key = (o: Partial<Key> = {}): Key => ({ sequence: "", ctrl: false, meta: false, shift: false, ...o });
const list = (): ListState<string> =>
  makeList([
    { label: "help", value: "help" },
    { label: "model", value: "model" },
    { label: "mode", value: "mode" },
  ]);

test("filtering narrows the list and resets the index; no filter → all", () => {
  assert.equal(filtered(list()).length, 3);
  const r = applyKey({ ...list(), index: 2 }, key({ sequence: "m" }));
  assert.equal(r.state.filter, "m");
  assert.equal(r.state.index, 0);
  assert.deepEqual(filtered(r.state).map((i) => i.value), ["model", "mode"]);
  const r2 = applyKey(r.state, key({ sequence: "o" })); // "mo"
  assert.deepEqual(filtered(r2.state).map((i) => i.value), ["model", "mode"]);
  assert.equal(filtered(applyKey(r2.state, key({ sequence: "d" })).state).length, 2); // "mod"
});

test("Up/Down clamp within the filtered list; Enter chooses; Esc cancels", () => {
  assert.equal(applyKey({ ...list(), index: 0 }, key({ name: "up" })).state.index, 0); // clamp low
  const down = applyKey({ ...list(), index: 0 }, key({ name: "down" }));
  assert.equal(down.state.index, 1);
  assert.equal(applyKey({ ...list(), index: 2 }, key({ name: "down" })).state.index, 2); // clamp high
  assert.equal(applyKey({ ...list(), index: 1 }, key({ name: "return" })).chosen, "model");
  assert.equal(applyKey(list(), key({ name: "escape" })).cancelled, true);
  assert.equal(applyKey({ ...list(), index: 1 }, key({ name: "backspace" })).state.index, 0);
});

test("renderList marks the selected row; plain vs themed", () => {
  const out = renderList({ ...list(), index: 1 }, makeTheme(false));
  assert.ok(out.includes("help") && out.includes("model") && out.includes("mode"));
  assert.ok(out.includes("❯")); // selection marker
  assert.ok(!out.includes("\x1b"));
  assert.ok(renderList({ ...list(), index: 1 }, makeTheme(true)).includes("\x1b["));
  assert.equal(renderList({ items: [], filter: "", index: 0 }, makeTheme(false)), "  (no matches)");
});
