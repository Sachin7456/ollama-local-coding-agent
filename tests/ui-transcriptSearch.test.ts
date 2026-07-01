// Auto-tests: pure transcript substring search.

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTranscript } from "../src/ui/transcriptSearch.ts";

test("finds matching lines case-insensitively with index + role", () => {
  const msgs = [
    { role: "user", content: "Read config.ts\nand summarize" },
    { role: "assistant", content: "The CONFIG file sets the port." },
    { role: "tool", content: { blocks: [] } }, // non-string skipped
  ];
  const hits = searchTranscript(msgs, "config");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { index: 0, role: "user", line: "Read config.ts" });
  assert.equal(hits[1].index, 1);
});

test("blank query → no matches; max caps results", () => {
  const msgs = [{ role: "user", content: "a\na\na\na" }];
  assert.deepEqual(searchTranscript(msgs, "   "), []);
  assert.equal(searchTranscript(msgs, "a", 2).length, 2);
});
