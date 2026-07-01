// shellMode — the `!command` escape: the USER (not the model) runs a shell command and its output is injected into
// the conversation. Because it's an explicit user action (like a shell escape), it bypasses the model's permission
// gate. Bounded (timeout + maxBuffer). SRP: just runs + returns combined output.

import { spawnSync } from "node:child_process";

export function runShell(command: string): string {
  const res = spawnSync(command, { shell: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (res.error) return `(error: ${res.error.message})`;
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd();
  return out || "(no output)";
}
