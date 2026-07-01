// Auto-tests: pure todo checklist model + renderer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTodos, todoSummary, type Todo } from "../src/ui/todo.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { stripAnsi } from "../src/ui/width.ts";

const todos: Todo[] = [
  { content: "Read config", status: "completed" },
  { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
  { content: "Write docs", status: "pending" },
];

test("todoSummary: completed/total", () => {
  assert.equal(todoSummary(todos), "1/3");
  assert.equal(todoSummary([]), "0/0");
});

test("renderTodos: glyphs + in_progress shows activeForm", () => {
  const out = stripAnsi(renderTodos(todos, makeTheme(true)));
  assert.match(out, /✓ Read config/);
  assert.match(out, /▶ Running tests/); // activeForm, not "Run tests"
  assert.ok(!out.includes("Run tests\n") && out.includes("Running tests"));
  assert.match(out, /☐ Write docs/);
  assert.match(renderTodos([], makeTheme(false)), /no tasks/);
});
