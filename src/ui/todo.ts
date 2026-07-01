// todo — a PURE checklist model + renderer (SRP: state + display; no I/O). Three lifecycle states; the in-progress
// item shows its `activeForm` ("Running tests") while pending/completed show `content` ("Run tests"). Backs an
// agent-driven task list / `/todo`; the live pinned panel (Ctrl+T) is wired later. Unit-testable — no terminal.

import { type Theme, makeTheme } from "./theme.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string; // shown when pending/completed
  status: TodoStatus;
  activeForm?: string; // shown when in_progress (falls back to content)
}

const GLYPH: Record<TodoStatus, string> = { pending: "☐", in_progress: "▶", completed: "✓" };

/** "2/5" — completed / total. */
export function todoSummary(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  return `${done}/${todos.length}`;
}

export function renderTodos(todos: Todo[], theme: Theme = makeTheme(false)): string {
  if (todos.length === 0) return theme.dim("  (no tasks)");
  return todos
    .map((t) => {
      const g = GLYPH[t.status];
      if (t.status === "completed") return `  ${theme.ok(g)} ${theme.dim(t.content)}`;
      if (t.status === "in_progress") return `  ${theme.accent(`${g} ${t.activeForm ?? t.content}`)}`;
      return `  ${theme.dim(g)} ${t.content}`;
    })
    .join("\n");
}
