// Small, pure REPL helpers — extracted so they're unit-testable without starting the CLI.

/**
 * Decide what a Ctrl+C (SIGINT) should do in the interactive REPL:
 * cancel the in-flight task (and return to the prompt), or exit cleanly when idle.
 * Kept pure so the policy can be tested; the readline wiring lives in main.ts.
 */
export function interruptAction(isTaskRunning: boolean): "cancel" | "exit" {
  return isTaskRunning ? "cancel" : "exit";
}

/**
 * One-line OS/shell hint for the system prompt so the model uses the right shell tool + commands:
 * PowerShell on Windows, bash on macOS/Linux. Pure (takes the platform) so it's unit-testable.
 */
export function shellGuidance(platform: string): string {
  if (platform === "win32") {
    return (
      "You are on Windows. Use the `powershell` tool for shell + system tasks — write PowerShell " +
      "cmdlets (Get-Process, Get-ChildItem, Get-Content, Select-String, Get-Counter). For the top CPU " +
      "processes: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 10`. Do NOT use " +
      "`ps`/`top`/`ls`/`grep` (those are Unix)."
    );
  }
  return "You are on macOS/Linux. Use the `bash` tool for shell + system tasks (ls, find, grep, ps, du).";
}

/** Parse a permission-prompt reply: y/yes → once, a/always → always, anything else → no. */
export function parseAskReply(input: string): "once" | "always" | "no" {
  const s = input.trim().toLowerCase();
  if (s === "y" || s === "yes") return "once";
  if (s === "a" || s === "always") return "always";
  return "no";
}


export async function runLines(
  lines: AsyncIterable<string>,
  handle: (line: string) => Promise<boolean>,
): Promise<void> {
  for await (const raw of lines) {
    if (!(await handle(raw.trim()))) break;
  }
}

/**
 * Whether a REPL line should be dispatched as a slash-command. ONLY interactive input dispatches commands;
 * piped / pasted / non-interactive input must treat a `/`-line as plain task text (so a pasted `/exit` or
 * any `/word` can't silently control or end the run). Pure → unit-testable.
 */
export function isCommandLine(input: string, isInteractive: boolean): boolean {
  return isInteractive && input.startsWith("/");
}
