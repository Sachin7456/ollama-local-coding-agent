// Auto-tests: the `/` palette items derive from the command registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteItems } from "../src/ui/palette.ts";
import { COMMANDS } from "../src/ui/commands.ts";

test("paletteItems: one per command, labelled '/name', hint = summary", () => {
  const items = paletteItems();
  assert.equal(items.length, COMMANDS.length);
  const help = items.find((i) => i.value.name === "help");
  assert.ok(help);
  assert.ok(help!.label.startsWith("/help"));
  assert.equal(help!.hint, "list all commands");
});
