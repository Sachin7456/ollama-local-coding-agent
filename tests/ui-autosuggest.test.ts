// Auto-tests: pure ghost-text suggestion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { suggest } from "../src/ui/autosuggest.ts";

test("suggests the most-recent history entry that extends the prefix", () => {
  const hist = ["fix the parser", "fix the parser bug", "run tests"];
  assert.equal(suggest("fix the parser", hist), " bug"); // most recent extending match
  assert.equal(suggest("run", hist), " tests");
  assert.equal(suggest("", hist), ""); // empty prefix → no suggestion
  assert.equal(suggest("deploy", hist), ""); // no match
  assert.equal(suggest("run tests", hist), ""); // exact (not strictly longer) → nothing
});

test("falls back to slash-command completion", () => {
  const cmds = ["mode", "model", "compact"];
  assert.equal(suggest("/mod", [], cmds), "e"); // first match "mode"
  assert.equal(suggest("/co", [], cmds), "mpact");
  assert.equal(suggest("/xyz", [], cmds), "");
  assert.equal(suggest("/mode x", [], cmds), ""); // has a space → not a bare command
});
