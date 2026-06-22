// Permission gate (allow / ask / deny).
//
// Zero deps. The permission model:
//   - permission MODES (default / acceptEdits / plan / bypass)
//   - rule lists, with DENY checked first so it wins even over bypass (the safety floor)
//   - read-only tools auto-allow; mutating tools "ask" (unless the mode says otherwise)
//
// Decision order in decide():
//   1. deny rules   -> deny      (wins over everything, including bypass)
//   2. bypass mode  -> allow
//   3. allow rules  -> allow
//   4. ask rules    -> ask
//   5. defaults:    read-only -> allow; plan -> deny; acceptEdits -> allow; else ask

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** from the Tool — read-only tools are safe to auto-allow */
  readOnly: boolean;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
}

export interface PermissionRule {
  /** exact tool name, or "*" for any tool */
  tool: string;
  decision: PermissionDecision;
  /** optional finer match on the call's arguments */
  when?: (args: Record<string, unknown>) => boolean;
  reason?: string;
}

export interface PermissionConfig {
  mode: PermissionMode;
  deny: PermissionRule[];
  allow: PermissionRule[];
  ask: PermissionRule[];
}

function ruleMatches(rule: PermissionRule, req: PermissionRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== req.toolName) return false;
  if (rule.when && !rule.when(req.args)) return false;
  return true;
}

/**
 * Known-dangerous command fragments (best-effort safety floor — NOT a complete
 * sandbox). Covers POSIX +
 * Windows/PowerShell since this machine is Windows.
 */
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*(rf|fr)[a-zA-Z]*\s+(\/(\s|$|\*)|~|\$HOME|--no-preserve-root)/i, // rm -rf / ~ /* etc.
  /:\(\)\s*\{\s*:\s*\|\s*:&?\s*\}\s*;\s*:/, // fork bomb
  /\bmkfs(\.\w+)?\s/i, // make filesystem
  /\bdd\b[^\n]*\bof=\/dev\//i, // dd onto a device
  />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/i, // redirect to a block device
  /\bchmod\s+(-[a-zA-Z]*\s+)*0?777\s+\//i, // chmod 777 on root paths
  /\b(shutdown|reboot|halt|poweroff)\b/i, // power state
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // pipe download to shell
  /\bformat\s+[a-zA-Z]:/i, // Windows: format C:
  /Remove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b/i, // PowerShell recursive force delete
  /\bdel\b\s+\/[sq]\b/i, // Windows del /s /q
];

/** A "*" deny rule that scans common command args for dangerous patterns. */
export function dangerousCommandRule(): PermissionRule {
  return {
    tool: "*",
    decision: "deny",
    reason: "matches a known-dangerous command pattern",
    when: (args) => {
      const cmd = `${args.command ?? ""} ${args.cmd ?? ""} ${args.script ?? ""}`;
      return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(cmd));
    },
  };
}

export class PermissionEngine {
  private cfg: PermissionConfig;

  constructor(cfg: PermissionConfig) {
    this.cfg = cfg;
  }

  get mode(): PermissionMode {
    return this.cfg.mode;
  }
  setMode(m: PermissionMode): void {
    this.cfg.mode = m;
  }

  decide(req: PermissionRequest): PermissionResult {
    // 1. deny wins over everything (even bypass) — the safety floor.
    for (const r of this.cfg.deny) {
      if (ruleMatches(r, req)) {
        return { decision: "deny", reason: r.reason ?? `denied by rule for ${r.tool}` };
      }
    }
    // 2. bypass: allow everything that wasn't explicitly denied.
    if (this.cfg.mode === "bypass") {
      return { decision: "allow", reason: "bypass mode" };
    }
    // 3. explicit allow rules.
    for (const r of this.cfg.allow) {
      if (ruleMatches(r, req)) {
        return { decision: "allow", reason: r.reason ?? `allowed by rule for ${r.tool}` };
      }
    }
    // 4. explicit ask rules.
    for (const r of this.cfg.ask) {
      if (ruleMatches(r, req)) {
        return { decision: "ask", reason: r.reason ?? `ask required by rule for ${r.tool}` };
      }
    }
    // 5. defaults by read-only + mode.
    if (req.readOnly) return { decision: "allow", reason: "read-only tool" };
    if (this.cfg.mode === "plan") return { decision: "deny", reason: "plan mode is read-only" };
    if (this.cfg.mode === "acceptEdits") {
      return { decision: "allow", reason: "acceptEdits mode allows mutations" };
    }
    return { decision: "ask", reason: "mutating tool requires confirmation" };
  }
}

/** A default engine: a dangerous-command deny floor, nothing else pre-allowed. */
export function createDefaultPermissions(mode: PermissionMode = "default"): PermissionEngine {
  return new PermissionEngine({
    mode,
    deny: [dangerousCommandRule()],
    allow: [],
    ask: [],
  });
}

/** Build a PermissionRequest from a Tool + the model's args. */
export function requestFromTool(
  tool: { name: string; readOnly: boolean },
  args: Record<string, unknown>,
): PermissionRequest {
  return { toolName: tool.name, args, readOnly: tool.readOnly };
}
