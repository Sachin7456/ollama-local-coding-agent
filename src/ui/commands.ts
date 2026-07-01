// The single source of truth for slash-commands: metadata only (name, aliases, summary, usage). It powers /help,
// Tab-autocomplete, the startup banner, and "did you mean" suggestions — so those can never drift from each other.
// Handlers live in main.ts (they need the mutable REPL state); dispatch resolves a typed line to a spec here first.

import type { Theme } from "./theme.ts";

export interface CommandSpec {
  name: string; // canonical, without the leading slash
  aliases?: string[];
  summary: string;
  usage?: string; // argument hint, e.g. "[tag]"
  options?: string[]; // choosable argument values → the palette opens a submenu to pick one
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", aliases: ["?"], summary: "list all commands" },
  { name: "model", usage: "[tag] [--persist]", summary: "switch model, or pick one interactively (no arg)" },
  { name: "models", summary: "list configured + on-machine models" },
  { name: "mode", usage: "[default|acceptEdits|plan|bypass]", summary: "show or switch the permission mode", options: ["default", "acceptEdits", "plan"] },
  { name: "context", aliases: ["ctx", "tokens"], summary: "show how full the context window is" },
  { name: "cost", aliases: ["usage"], summary: "show this session's token usage + estimated cost" },
  { name: "search", usage: "<text>", summary: "search this conversation for text" },
  { name: "sessions", summary: "list this project's saved sessions" },
  { name: "new", summary: "start a fresh session" },
  { name: "resume", summary: "switch to another saved session (searchable picker)" },
  { name: "rename", usage: "<title>", summary: "name this session (for search / resume)" },
  { name: "compact", summary: "summarize the conversation to free up context" },
  { name: "editor", summary: "compose your message in $EDITOR" },
  { name: "perms", summary: "show remembered 'always allow' rules" },
  { name: "theme", usage: "[auto|always|never]", summary: "show or set terminal color", options: ["auto", "always", "never"] },
  { name: "clear", aliases: ["cls"], summary: "clear the screen" },
  { name: "exit", aliases: ["quit"], summary: "exit the session" },
];

/** The first whitespace-token of a line, lowercased, without the leading slash. "/Model x" -> "model". */
export function commandToken(line: string): string {
  const first = line.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^\//, "").toLowerCase();
}

/** Resolve a typed line to its CommandSpec (matching name or alias), or undefined if unknown. */
export function resolveCommand(line: string): CommandSpec | undefined {
  const tok = commandToken(line);
  if (!tok) return undefined;
  return COMMANDS.find((c) => c.name === tok || (c.aliases ?? []).includes(tok));
}

/** Every completable command token, with the leading slash (canonical names + aliases), sorted. */
export function commandCompletions(): string[] {
  const out: string[] = [];
  for (const c of COMMANDS) {
    out.push(`/${c.name}`);
    for (const a of c.aliases ?? []) out.push(`/${a}`);
  }
  return out.sort();
}

/** Compact one-line command list for the banner + the unknown-command hint. */
export function commandSummary(): string {
  return COMMANDS.map((c) => `/${c.name}`).join("  ");
}

/** Aligned, themed multi-line help for /help. */
export function formatHelp(theme: Theme): string {
  const left = COMMANDS.map((c) => `/${c.name}${c.usage ? " " + c.usage : ""}`);
  const width = Math.max(...left.map((s) => s.length));
  const lines = COMMANDS.map((c, i) => {
    const padded = left[i].padEnd(width);
    const alias = c.aliases && c.aliases.length ? theme.dim(`  (${c.aliases.map((a) => "/" + a).join(", ")})`) : "";
    return `  ${theme.accent(padded)}  ${c.summary}${alias}`;
  });
  return ["Commands:", ...lines].join("\n");
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** "did you mean" for an unknown command: nearest name/alias by prefix or small edit distance, else undefined. */
export function suggest(line: string): string | undefined {
  const tok = commandToken(line);
  if (!tok) return undefined;
  let best: { name: string; d: number } | undefined;
  for (const c of COMMANDS) {
    for (const cand of [c.name, ...(c.aliases ?? [])]) {
      const d = cand.startsWith(tok) || tok.startsWith(cand) ? 0 : editDistance(tok, cand);
      if (!best || d < best.d) best = { name: c.name, d };
    }
  }
  if (!best || best.d > 3) return undefined;
  return `/${best.name}`;
}
