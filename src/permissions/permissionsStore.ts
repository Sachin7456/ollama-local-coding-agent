// Persistence for "always allow" rules so the auto-approve set grows WITHOUT code edits.
// PER-PROJECT store at <harnessDir>/projects/<projectKey>/permissions.json (dir override via QWEN_HARNESS_DIR,
// like sessions). Per-project so an "always allow" granted in one project never auto-approves in another. The
// store lives under the user dir (NOT in the repo), so a cloned repo can't ship approvals (no supply-chain
// surface) and no workspace-trust prompt is needed. The dangerous-command deny floor lives in code and is NEVER
// persisted here — a remembered allow can never override it (decide() checks deny before allow).

import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../state/session.ts";
import type { PermissionRule } from "./permissions.ts";

/** Serialized form (only a tool + a command prefix — no functions, so it round-trips as JSON). */
export interface StoredRule {
  tool: string;
  commandPrefix: string;
}

function storePath(cwd: string): string {
  return path.join(projectDir(cwd), "permissions.json");
}

function readStored(cwd: string): StoredRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(cwd), "utf8")) as { allow?: StoredRule[] };
    if (!Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter(
      (r) => r && typeof r.tool === "string" && typeof r.commandPrefix === "string",
    );
  } catch {
    return []; // no file / unreadable / malformed → no remembered rules (fail-safe)
  }
}

/** Remembered allow rules for THIS project as PermissionRules (ready for PermissionEngine.addAllowRule). */
export function loadPermissionRules(cwd: string): PermissionRule[] {
  return readStored(cwd).map((r) => ({
    tool: r.tool,
    decision: "allow",
    commandPrefix: r.commandPrefix,
    reason: "remembered (always allow)",
  }));
}

const STORE_VERSION = 1; // bump + migrate in readStored() if the on-disk shape ever changes

/** Append a remembered allow rule for THIS project (deduped) and persist atomically. False on write failure. */
export function rememberAllowRule(tool: string, commandPrefix: string, cwd: string): boolean {
  const rules = readStored(cwd);
  if (rules.some((r) => r.tool === tool && r.commandPrefix === commandPrefix)) return true;
  rules.push({ tool, commandPrefix });
  try {

    const file = storePath(cwd);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, allow: rules }, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
