// palette — builds the `/` command-menu items from the ONE command registry (OCP: adding a command to the registry
// automatically appears in the palette, /help and autocomplete). Pure → the interactive part is selectList.

import { COMMANDS, type CommandSpec } from "./commands.ts";
import type { ListItem } from "./selectList.ts";

/** List items for the `/` palette: label shows the command (+usage hint text), value is the spec. */
export function paletteItems(): ListItem<CommandSpec>[] {
  return COMMANDS.map((c) => ({
    label: `/${c.name}${c.usage ? " " + c.usage : ""}`,
    value: c,
    hint: c.summary,
  }));
}
