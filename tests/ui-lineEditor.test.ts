// Auto-tests: the pure multi-line input reducer — editing, undo/redo, kill-ring/yank, word ops. No terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyEditor, withText, applyKey, renderInput, replace, type EditorState } from "../src/ui/lineEditor.ts";
import type { Key } from "../src/ui/io.ts";

const key = (o: Partial<Key> = {}): Key => ({ sequence: "", ctrl: false, meta: false, shift: false, ...o });
const mk = (text: string, cursor?: number): EditorState => ({ ...emptyEditor(), text, cursor: cursor ?? text.length });

test("printable insert; Enter submits; backslash / Ctrl+J make newlines", () => {
  let r = applyKey(emptyEditor(), key({ sequence: "h" }));
  r = applyKey(r.state, key({ sequence: "i" }));
  assert.equal(r.state.text, "hi");
  assert.equal(r.state.cursor, 2);
  assert.equal(applyKey(withText("hello"), key({ name: "return" })).submit, "hello");
  assert.equal(applyKey(mk("a\\", 2), key({ name: "return" })).state.text, "a\n");
  assert.equal(applyKey(mk("ab", 2), key({ name: "j", ctrl: true })).state.text, "ab\n");
});

test("backspace / delete / char + word cursor movement", () => {
  assert.equal(applyKey(mk("ab", 2), key({ name: "backspace" })).state.text, "a");
  assert.equal(applyKey(mk("ab", 0), key({ name: "delete" })).state.text, "b");
  assert.equal(applyKey(mk("ab", 2), key({ name: "left" })).state.cursor, 1);
  assert.equal(applyKey(mk("foo bar", 7), key({ name: "left", ctrl: true })).state.cursor, 4); // word-left → start of "bar"
  assert.equal(applyKey(mk("foo bar", 0), key({ name: "right", ctrl: true })).state.cursor, 3); // word-right → end of "foo"
});

test("undo coalesces a typing run; redo restores", () => {
  let s = emptyEditor();
  s = applyKey(s, key({ sequence: "a" })).state;
  s = applyKey(s, key({ sequence: "b" })).state; // "ab" — one coalesced undo step
  const u = applyKey(s, key({ name: "z", ctrl: true })).state;
  assert.equal(u.text, ""); // whole run undone
  assert.equal(applyKey(u, key({ sequence: "\x1e" })).state.text, "ab"); // redo
});

test("kill-ring: Ctrl+U/K feed it, Ctrl+Y yanks, Alt+Y rotates", () => {
  const killed = applyKey(mk("hello world", 11), key({ name: "u", ctrl: true })).state;
  assert.equal(killed.text, "");
  assert.deepEqual(killed.kill, ["hello world"]);
  assert.equal(applyKey(killed, key({ name: "y", ctrl: true })).state.text, "hello world"); // yank back
  // two separate kills → two ring entries; yank then Alt+Y rotates to the older one
  let a = applyKey(mk("abc", 3), key({ name: "u", ctrl: true })).state; // kill "abc"
  a = applyKey({ ...a, text: "xyz", cursor: 3, lastOp: "nav" }, key({ name: "u", ctrl: true })).state; // kill "xyz"
  assert.deepEqual(a.kill, ["xyz", "abc"]);
  const y1 = applyKey(a, key({ name: "y", ctrl: true })).state;
  assert.equal(y1.text, "xyz");
  assert.equal(applyKey(y1, key({ name: "y", meta: true })).state.text, "abc"); // yank-pop
});

test("word kill: Ctrl+W back, Alt+D forward", () => {
  const w = applyKey(mk("foo bar", 7), key({ name: "w", ctrl: true })).state;
  assert.equal(w.text, "foo ");
  assert.deepEqual(w.kill, ["bar"]);
  const d = applyKey(mk("foo bar", 0), key({ name: "d", meta: true })).state;
  assert.equal(d.text, " bar");
});

test("replace() preserves undoability; renderInput prefixes prompt + continuation", () => {
  const r = replace(mk("old", 3), "new text", 8);
  assert.equal(r.text, "new text");
  assert.equal(applyKey(r, key({ name: "z", ctrl: true })).state.text, "old"); // undo the replace
  assert.equal(renderInput(mk("a\nb", 3), "> "), "> a\n  b");
});

test("Up/Down request history", () => {
  assert.equal(applyKey(withText("x"), key({ name: "up" })).history, "prev");
  assert.equal(applyKey(withText("x"), key({ name: "down" })).history, "next");
});
