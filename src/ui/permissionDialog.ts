// permissionDialog — the choices for an interactive allow/deny/always approval, as data (OCP) so the same
// selectList widget can render it in rich mode. Pure. (The default readline path keeps its y/a/N text prompt;
// this backs the raw-mode dialog.)

import type { ListItem } from "./selectList.ts";

export type PermChoice = "allow" | "always" | "deny";

export function permissionChoices(toolName: string): ListItem<PermChoice>[] {
  return [
    { label: "Allow once", value: "allow" },
    { label: `Always allow ${toolName}`, value: "always" },
    { label: "Deny", value: "deny" },
  ];
}
