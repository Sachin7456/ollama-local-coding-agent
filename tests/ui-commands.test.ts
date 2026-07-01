// Auto-tests: the command registry (single source of truth) + readline completer. Pure, zero deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommand, commandToken, commandCompletions, commandSummary, formatHelp, suggest,
} from "../src/ui/commands.ts";
import { makeCompleter } from "../src/ui/completer.ts";
import { makeTheme } from "../src/ui/theme.ts";

test("resolveCommand: name, alias, case-insensitive; unknown → undefined", () => {
  assert.equal(resolveCommand("/help")?.name, "help");
  assert.equal(resolveCommand("/?")?.name, "help"); // alias
  assert.equal(resolveCommand("/MODEL qwen")?.name, "model"); // case + arg
  assert.equal(resolveCommand("/quit")?.name, "exit");
  assert.equal(resolveCommand("/compact")?.name, "compact");
  assert.equal(resolveCommand("/resume")?.name, "resume");
  assert.equal(resolveCommand("/editor")?.name, "editor");
  assert.equal(resolveCommand("/nope"), undefined);
  assert.deepEqual(resolveCommand("/mode")?.options, ["default", "acceptEdits", "plan"]); // arg submenu options
  assert.deepEqual(resolveCommand("/theme")?.options, ["auto", "always", "never"]);
  assert.equal(commandToken("/model foo"), "model");
});

test("completions + summary + help all derive from the one registry", () => {
  const comps = commandCompletions();
  assert.ok(comps.includes("/help") && comps.includes("/model") && comps.includes("/?"));
  assert.ok(commandSummary().includes("/help") && commandSummary().includes("/exit"));
  const help = formatHelp(makeTheme(false));
  assert.ok(help.includes("/help") && help.includes("list all commands"));
  assert.ok(!help.includes("\x1b")); // theme off → no codes
  assert.ok(formatHelp(makeTheme(true)).includes("\x1b[")); // theme on → styled
});

test("suggest: nearest command for a typo, undefined when too far", () => {
  assert.ok(["/model", "/mode"].includes(suggest("/modle") ?? "")); // typo near both — returns a close one
  assert.equal(suggest("/hepl"), "/help");
  assert.equal(suggest("/zzzzzz"), undefined);
});

test("completer: command names, then model tags after '/model '", () => {
  const c = makeCompleter(() => ["qwen2.5-coder:7b", "qwen3-coder:30b"]);
  const [cmds, sub] = c("/mo");
  assert.ok(cmds.includes("/model") && cmds.includes("/mode"));
  assert.equal(sub, "/mo");
  const [tags, p] = c("/model qwen3");
  assert.deepEqual(tags, ["qwen3-coder:30b"]);
  assert.equal(p, "qwen3");
  assert.deepEqual(c("/model ")[0], ["qwen2.5-coder:7b", "qwen3-coder:30b"]); // empty partial → all
  assert.deepEqual(c("hello there"), [[], "hello there"]); // not a command line
});

test("completer: @-token fuzzy-completes file paths when a files provider is given", () => {
  const c = makeCompleter(() => [], () => ["src/main.ts", "src/ui/screen.ts", "readme.md"]);
  const [hits, sub] = c("look at @scr");
  assert.equal(sub, "@scr");
  assert.ok(hits.includes("@src/ui/screen.ts")); // fuzzy 'scr' → screen
  assert.ok(hits.every((h) => h.startsWith("@")));
  assert.deepEqual(c("@")[0].length > 0, true); // bare @ → some files
});
