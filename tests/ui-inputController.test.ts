// Auto-tests: the raw-mode input controller driven headlessly via FAKE KeySource + Screen (DIP). This exercises the
// rich interactive path — palette, paste-expand, ghost-text accept, submit/cancel/eof — WITHOUT a real TTY, catching
// crashes that the non-TTY piped smoke can't (there rl is present and readInput is never used).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readInput } from "../src/ui/inputController.ts";
import { permissionPrompt } from "../src/ui/permissionPrompt.ts";
import { runSelect } from "../src/ui/runSelect.ts";
import type { Key, KeySource, Screen } from "../src/ui/io.ts";
import { themeFor } from "../src/ui/theme.ts";

class FakeKeySource implements KeySource {
  private keyHandlers = new Set<(k: Key) => void>();
  private pasteHandlers = new Set<(t: string) => void>();
  onKey(h: (k: Key) => void): () => void {
    this.keyHandlers.add(h);
    return () => this.keyHandlers.delete(h);
  }
  onPaste(h: (t: string) => void): () => void {
    this.pasteHandlers.add(h);
    return () => this.pasteHandlers.delete(h);
  }
  start(): void {}
  stop(): void {}
  emit(k: Partial<Key>): void {
    const key: Key = { sequence: "", ctrl: false, meta: false, shift: false, ...k };
    for (const h of [...this.keyHandlers]) h(key);
  }
  type(s: string): void {
    for (const ch of s) this.emit({ sequence: ch });
  }
  paste(t: string): void {
    for (const h of [...this.pasteHandlers]) h(t);
  }
}

class FakeScreen implements Screen {
  out = "";
  columns(): number {
    return 80;
  }
  rows(): number {
    return 24;
  }
  write(s: string): void {
    this.out += s;
  }
  clearBelow(): void {}
  up(): void {}
  hideCursor(): void {}
  showCursor(): void {}
}

const theme = themeFor("never");
const run = (drive: (k: FakeKeySource) => void, opts: { history?: string[] } = {}) => {
  const keys = new FakeKeySource();
  const screen = new FakeScreen();
  const p = readInput({ keys, screen, theme }, { prompt: "> ", history: opts.history ?? [], files: () => [] });
  drive(keys);
  return { p, screen };
};

test("types a line and submits on Enter", async () => {
  const { p } = run((k) => {
    k.type("hello");
    k.emit({ name: "return" });
  });
  assert.deepEqual(await p, { kind: "submit", text: "hello" });
});

test("Ctrl+C cancels; Ctrl+D on empty buffer is EOF", async () => {
  const { p: cancel } = run((k) => k.emit({ name: "c", ctrl: true }));
  assert.deepEqual(await cancel, { kind: "cancel" });
  const { p: eof } = run((k) => k.emit({ name: "d", ctrl: true }));
  assert.deepEqual(await eof, { kind: "eof" });
});

test("a large paste collapses to a placeholder and expands back on submit", async () => {
  const big = "L1\nL2\nL3\nL4\nL5\nL6";
  const { p, screen } = run((k) => {
    k.paste(big);
    k.emit({ name: "return" });
  });
  assert.match(screen.out, /\[Pasted text #1 \+6 lines\]/); // placeholder was rendered
  assert.deepEqual(await p, { kind: "submit", text: big }); // expanded on submit
});

test("ghost-text: Right accepts the history suggestion", async () => {
  const { p } = run(
    (k) => {
      k.type("deploy");
      k.emit({ name: "right" }); // accept ghost " to prod"
      k.emit({ name: "return" });
    },
    { history: ["deploy to prod"] },
  );
  assert.deepEqual(await p, { kind: "submit", text: "deploy to prod" });
});

test("typing '/' opens the command palette (renders without crashing)", async () => {
  const { p, screen } = run((k) => {
    k.type("/");
    k.emit({ name: "escape" }); // close palette
    k.emit({ name: "return" }); // submit "/"
  });
  assert.match(screen.out, /help/); // palette listed commands
  assert.equal((await p).kind, "submit");
});

test("Shift+Tab cycles the mode live (buffer preserved) via onModeCycle", async () => {
  let cycles = 0;
  const keys = new FakeKeySource();
  const screen = new FakeScreen();
  const p = readInput(
    { keys, screen, theme },
    {
      prompt: "> ",
      history: [],
      files: () => [],
      onModeCycle: () => {
        cycles += 1;
        return "MODE=plan";
      },
    },
  );
  keys.type("hi");
  keys.emit({ name: "tab", shift: true }); // cycle mode
  keys.emit({ name: "return" });
  assert.deepEqual(await p, { kind: "submit", text: "hi" }); // buffer kept across the cycle
  assert.equal(cycles, 1);
  assert.match(screen.out, /MODE=plan/); // refreshed status painted
});

const runPerm = (drive: (k: FakeKeySource) => void, info: { toolName: string; preview?: string } = { toolName: "bash" }) => {
  const keys = new FakeKeySource();
  const screen = new FakeScreen();
  const p = permissionPrompt({ keys, screen, theme }, info);
  drive(keys);
  return { p, screen };
};

test("permission dialog: Enter=allow, a=always, n/Esc=deny, Down+Enter=always", async () => {
  assert.equal(await runPerm((k) => k.emit({ name: "return" })).p, "allow");
  assert.equal(await runPerm((k) => k.emit({ name: "a" })).p, "always");
  assert.equal(await runPerm((k) => k.emit({ name: "n" })).p, "deny");
  assert.equal(await runPerm((k) => k.emit({ name: "escape" })).p, "deny");
  assert.equal(
    await runPerm((k) => {
      k.emit({ name: "down" });
      k.emit({ name: "return" });
    }).p,
    "always",
  );
});

test("permission dialog renders the preview + choices", async () => {
  const { p, screen } = runPerm((k) => k.emit({ name: "n" }), { toolName: "bash", preview: "rm -rf tmp" });
  await p;
  assert.match(screen.out, /rm -rf tmp/);
  assert.match(screen.out, /Always allow bash/);
});

const items = [
  { label: "alpha", value: "a" },
  { label: "beta", value: "b" },
  { label: "gamma", value: "g" },
];
const runPick = (drive: (k: FakeKeySource) => void) => {
  const keys = new FakeKeySource();
  const screen = new FakeScreen();
  const p = runSelect({ keys, screen, theme }, items, "Pick:");
  drive(keys);
  return p;
};

test("runSelect: Enter picks current, Down+Enter next, type-to-filter, Esc cancels", async () => {
  assert.equal(await runPick((k) => k.emit({ name: "return" })), "a");
  assert.equal(
    await runPick((k) => {
      k.emit({ name: "down" });
      k.emit({ name: "return" });
    }),
    "b",
  );
  assert.equal(
    await runPick((k) => {
      k.type("gam"); // filter to "gamma"
      k.emit({ name: "return" });
    }),
    "g",
  );
  assert.equal(await runPick((k) => k.emit({ name: "escape" })), null);
});
