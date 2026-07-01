// Permission-mode cycling for the UI (Shift+Tab, or `/mode` with no arg). Pure. The dangerous `bypass` mode is
// intentionally NOT part of the cycle (you must set it explicitly) — cycling only rotates the safe trio.

import type { PermissionMode } from "../permissions/permissions.ts";

export const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];

/** Next mode in the safe cycle. If the current mode is outside the cycle (e.g. bypass), start at the beginning. */
export function cycleMode(current: PermissionMode): PermissionMode {
  const i = MODE_CYCLE.indexOf(current);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
}
