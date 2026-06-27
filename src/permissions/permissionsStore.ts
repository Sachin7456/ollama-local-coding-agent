// Persistence for "always allow" rules so the auto-approve set grows per-user WITHOUT code edits.
// User-global store at ~/.qwen-harness/permissions.json (dir override via QWEN_HARNESS_DIR, like sessions).
// The dangerous-command deny floor lives in code and is NEVER persisted here — a remembered allow can
// never override it (decide() checks deny before allow).

import fs from "node:fs";
import path from "node:path";
import { harnessDir } from "../state/session.ts";
import type { PermissionRule } from "./permissions.ts";

/** Serialized form (only a tool + a command prefix — no functions, so it round-trips as JSON). */
export interface StoredRule {
  tool: string;
  commandPrefix: string;
}

function storePath(): string {
  return path.join(harnessDir(), "permissions.json");
}

function readStored(): StoredRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as { allow?: StoredRule[] };
    if (!Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter(
      (r) => r && typeof r.tool === "string" && typeof r.commandPrefix === "string",
    );
  } catch {
    return []; // no file / unreadable / malformed → no remembered rules (fail-safe)
  }
}

/** Remembered allow rules as PermissionRules (ready for PermissionEngine.addAllowRule). */
export function loadPermissionRules(): PermissionRule[] {
  return readStored().map((r) => ({
    tool: r.tool,
    decision: "allow",
    commandPrefix: r.commandPrefix,
    reason: "remembered (always allow)",
  }));
}

const STORE_VERSION = 1; // bump + migrate in readStored() if the on-disk shape ever changes

/** Append a remembered allow rule (deduped) and persist atomically. Returns false on write failure. */
export function rememberAllowRule(tool: string, commandPrefix: string): boolean {
  const rules = readStored();
  if (rules.some((r) => r.tool === tool && r.commandPrefix === commandPrefix)) return true;
  rules.push({ tool, commandPrefix });
  try {
    fs.mkdirSync(harnessDir(), { recursive: true });
    // Atomic write: write a temp file then rename over the target (rename is atomic on one volume), so a
    // crash mid-write can never leave a corrupt permissions.json. `version` enables future migrations.
    const file = storePath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, allow: rules }, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
