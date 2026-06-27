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
//   5. safe read-only bash command -> allow (bash is the universal exploration tool);
//      then: read-only tool -> allow; plan -> deny; acceptEdits -> allow; else ask

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];
export function isPermissionMode(s: string): s is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(s);
}

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
  /** match only when `args.command` equals this OR starts with `prefix + " "` (word-boundary prefix). */
  commandPrefix?: string;
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
  if (rule.commandPrefix !== undefined) {
    const cmd = typeof req.args.command === "string" ? req.args.command.trim() : "";
    // Compound-command guard: a remembered prefix must NOT auto-allow a chained / redirected / substituted
    // command (`prefix && evil`, `prefix | sh`, `prefix; …`, `prefix > f`, `$(…)`). Any such char → no match
    // → fall through to ask / the deny floor. Parser-free.
    if (/[;&|<>`\n\r]|\$\(/.test(cmd)) return false;
    if (cmd !== rule.commandPrefix && !cmd.startsWith(rule.commandPrefix + " ")) return false;
  }
  if (rule.when && !rule.when(req.args)) return false;
  return true;
}

/**
 * Known-dangerous command fragments (best-effort safety floor — NOT a complete
 * sandbox). Covers POSIX +
 * Windows/PowerShell since this machine is Windows.
 */
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b(?=[^\n]*\s-[a-zA-Z-]*r)(?=[^\n]*\s-[a-zA-Z-]*f)[^\n]*\s(?:\/(?:\s|$|\*)|~|\$HOME|--no-preserve-root)/i, // rm recursive+force on / ~ $HOME /* --no-preserve-root — any flag order (-rf, -r -f, --recursive --force, interspersed)
  /:\(\)\s*\{\s*:\s*\|\s*:&?\s*\}\s*;\s*:/, // fork bomb
  /\bmkfs(\.\w+)?\s/i, // make filesystem
  /\bdd\b[^\n]*\bof=\/dev\//i, // dd onto a device
  />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/i, // redirect to a block device
  /\bchmod\s+(-[a-zA-Z]*\s+)*0?777\s+\//i, // chmod 777 on root paths
  /\b(shutdown|reboot|halt|poweroff)\b/i, // power state
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // pipe download to shell
  /\bformat\s+[a-zA-Z]:/i, // Windows: format C:
  /\b(?:Remove-Item|ri|rm)\b(?=[^\n]*-Recurse\b)(?=[^\n]*-Force\b)/i, // PS recursive force delete — any flag order, ri/rm aliases
  /\bdel\b[^\n]*\s\/[sq]\b/i, // Windows del /s /q — any flag order (e.g. del /f /s /q)
  /\bchmod\s+(-[a-z]*\s+)*-R[a-z]*\s+[^\n]*\b(777|000)\b/i, // chmod -R 777/000 (world-writable / lockout)
  /\bchown\s+(-[a-z]*\s+)*-R[a-z]*\s+[^\n]*\s(\/(\s|$)|\/etc\b|~(\/|\s|$))/i, // chown -R on / /etc ~
  /\bwipefs\b\s+\S/i, // wipe filesystem signatures
  /\bshred\s+-/i, // destructive overwrite (shred with flags)
  /\btruncate\b[^\n]*\s\/dev\//i, // truncate a device
  /\bcrontab\s+-r\b/i, // delete all cron jobs (no recovery)
  /\bcipher\s+\/w:/i, // Windows: wipe free disk space
  /\bdiskpart\b/i, // Windows: disk-partitioning tool
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

// ---- safe read-only bash classification --------------------------------------------------
// So bash can be the universal exploration/system tool (find a file, list a dir, "which process
// uses the most CPU") WITHOUT a prompt for every `ls`/`find`/`ps`. This auto-allows ONLY commands
// we are confident are read-only; it is fail-safe (anything uncertain returns false → "ask") and
// runs AFTER the dangerous-command deny floor. It is a gate, not a sandbox. NOTE: this allowlist
// is a security surface — adding a command needs review.

// Any one of these → reject (operators, substitution, expansion, globbing, quoting, separators).
// Broad on purpose: "reject, don't escape" (escaping shell metacharacters is error-prone).
const SHELL_METACHARS = /[|&;<>$`(){}\[\]*?~!\\'"\n\r]/;

const READONLY_COMMANDS = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "find", "grep", "rg", "ps", "du", "df",
  "stat", "file", "tree", "echo", "which", "where", "whoami", "uname",
  "netstat", "ss", "lsof", // read-only network/system inspection
  // NOTE: ifconfig/ipconfig/date/hostname are DUAL-USE (mutate with some args, e.g. `ipconfig /release`,
  // `date -s` / bare positional `date 20260101`, `hostname x`) — NOT name-allowlisted; they fall through to
  // "ask" (fail-safe). No static per-arg check is safe: `date` can set the clock via a bare positional arg
  // with NO flag at all — a survey of 12 OSS harnesses found none solve this without a container/LLM.
]);

// find actions that write or execute → never auto-allow.
const FIND_WRITE_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf",
]);

// git subcommands that cannot mutate regardless of their (metachar-free) args.
const GIT_ALWAYS_SAFE = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog",
]);

// "dual" git subcommands: safe ONLY in their listing form (every extra arg a known read flag).
const GIT_LIST_FLAGS: Record<string, Set<string>> = {
  branch: new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "--show-current", "--merged", "--no-merged"]),
  tag: new Set(["-l", "--list", "-n"]),
  remote: new Set(["-v", "--verbose"]),
};

// Strip safe leading wrappers (time/nice/nohup/timeout/stdbuf). NOT env/xargs/sudo/npx/docker.
function stripBashWrappers(tokens: string[]): string[] {
  let t = tokens;
  for (let guard = 0; guard < 4 && t.length > 0; guard++) {
    const head = t[0].toLowerCase();
    if (head === "time") t = t.slice(t[1] === "-p" ? 2 : 1);
    else if (head === "nohup") t = t.slice(1);
    else if (head === "nice") t = t[1] === "-n" ? t.slice(3) : t.slice(1);
    else if (head === "timeout") t = t.slice(2); // consume the duration token
    else if (head === "stdbuf") {
      let i = 1;
      while (i < t.length && t[i].startsWith("-")) i++;
      t = t.slice(i);
    } else break;
  }
  return t;
}

function isReadOnlyGit(rest: string[]): boolean {
  const sub = rest[0]?.toLowerCase();
  if (!sub) return false;
  if (GIT_ALWAYS_SAFE.has(sub)) return true;
  if (sub === "branch" || sub === "tag" || sub === "remote") {
    return rest.slice(1).every((a) => a.startsWith("-") && GIT_LIST_FLAGS[sub].has(a));
  }
  if (sub === "config") {
    const a = rest[1]?.toLowerCase();
    return a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l";
  }
  return false;
}

/**
 * True only for bash commands we are confident are read-only (safe to run without asking).
 * Conservative + fail-safe: rejects all shell metacharacters and anything not on the allowlist.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (SHELL_METACHARS.test(cmd)) return false;
  const tokens = stripBashWrappers(cmd.split(/\s+/));
  const head = tokens[0]?.toLowerCase();
  if (!head) return false;
  if (head === "git") return isReadOnlyGit(tokens.slice(1));
  if (head === "find") return !tokens.some((t) => FIND_WRITE_FLAGS.has(t.toLowerCase()));
  return READONLY_COMMANDS.has(head);
}

// ---- safe read-only PowerShell classification (the `powershell` tool's auto-allow) ----
// Unlike bash we ALLOW `|` (PowerShell is pipe-centric), but reject any arbitrary-code / chaining /
// redirect / variable / script-block character, and require every pipeline segment to start with a
// read-only cmdlet/alias. Anything else (script block `{…}`, `$(…)`, `iex`, `Remove-Item`, …) → false → "ask".
const PS_DANGER = /[;&$`{}<>]/;

const PS_READONLY_CMDLETS = new Set([
  "get-process", "get-childitem", "get-content", "get-item", "get-itemproperty", "get-location",
  "get-date", "get-command", "get-help", "get-member", "get-counter", "get-ciminstance",
  "get-computerinfo", "get-service", "get-history", "get-variable", "get-module", "test-path",
  "resolve-path", "select-string", "measure-object", "sort-object", "select-object", "where-object",
  "format-table", "format-list", "out-string", "convertto-json", "convertto-csv", "write-output", "echo",
]);

const PS_ALIASES: Record<string, string> = {
  ls: "get-childitem", dir: "get-childitem", gci: "get-childitem",
  cat: "get-content", gc: "get-content", type: "get-content",
  gps: "get-process", ps: "get-process",
  pwd: "get-location", gl: "get-location",
  gi: "get-item", gm: "get-member", gcm: "get-command",
  select: "select-object", sort: "sort-object", measure: "measure-object",
  "?": "where-object", where: "where-object",
  ft: "format-table", fl: "format-list", sls: "select-string",
};

/**
 * True only for PowerShell commands we are confident are read-only (safe to run without asking):
 * a `|`-pipeline whose every segment starts with a read-only cmdlet/alias and which contains no
 * arbitrary-code construct (script block, sub-expression, variable, call operator, chaining, redirect).
 */
export function isReadOnlyPowerShellCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (PS_DANGER.test(cmd)) return false;
  for (const seg of cmd.split("|")) {
    const head = seg.trim().split(/\s+/)[0]?.toLowerCase();
    if (!head) return false;
    const resolved = PS_ALIASES[head] ?? head;
    // PowerShell convention: a `Get-*` verb cmdlet is read-only — auto-allow ANY of them (so new ones
    // like Get-NetTCPConnection / Get-WmiObject scale WITHOUT code edits), plus the explicit non-Get
    // safe set above. (PS_DANGER already rejected script blocks / sub-expressions / `(`, `{`, `$`.)
    if (!resolved.startsWith("get-") && !PS_READONLY_CMDLETS.has(resolved)) return false;
  }
  return true;
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
    if (!isPermissionMode(m)) {
      throw new Error(`invalid mode "${m}" — must be one of: ${PERMISSION_MODES.join(", ")}`);
    }
    this.cfg.mode = m;
  }
  /** Add an allow rule at runtime (used by "always allow this command"). */
  addAllowRule(rule: PermissionRule): void {
    this.cfg.allow.push(rule);
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
    // A safe read-only shell command behaves like a read-only tool — bash is the universal
    // exploration tool, so `ls`/`find`/`ps`/etc. run without asking. Stays after the deny floor
    // (1) and explicit rules (3-4), so dangerous commands are still denied and user rules win.
    if (
      req.toolName === "bash" &&
      !req.readOnly &&
      isReadOnlyBashCommand(typeof req.args.command === "string" ? req.args.command : "")
    ) {
      return { decision: "allow", reason: "read-only shell command" };
    }
    if (
      req.toolName === "powershell" &&
      !req.readOnly &&
      isReadOnlyPowerShellCommand(typeof req.args.command === "string" ? req.args.command : "")
    ) {
      return { decision: "allow", reason: "read-only shell command" };
    }
    // plan mode = no changes at all: a tool that writes harness state (remember) is denied even though
    // it is flagged read-only for the workspace.
    if (this.cfg.mode === "plan" && req.toolName === "remember") {
      return { decision: "deny", reason: "plan mode makes no changes" };
    }
    if (req.readOnly) return { decision: "allow", reason: "read-only tool" };
    if (this.cfg.mode === "plan") return { decision: "deny", reason: "plan mode is read-only" };
    if (this.cfg.mode === "acceptEdits") {
      return { decision: "allow", reason: "acceptEdits mode allows mutations" };
    }
    if (req.toolName === "bash" || req.toolName === "powershell") {
      return { decision: "ask", reason: "not a recognized read-only command — confirm" };
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
