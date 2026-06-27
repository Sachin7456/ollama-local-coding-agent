// Optional per-project rules/instructions, loaded into the system prompt.
//
// Looks in the workspace (cwd) for a conventions file and returns its content as a prompt block
// (or "" if none / unreadable). Fail-safe + zero-dep (node:fs/path only). The content is treated as
// DATA by the model (the SYSTEM_PROMPT instructs it not to obey embedded directives), so a project
// file can set conventions ("answer in French", "use tabs") without becoming an injection vector.

import fs from "node:fs";
import path from "node:path";

const PROJECT_RULE_FILES = [".qwen-harness.md", "AGENTS.md", ".qwenrules"];
const PROJECT_RULES_CAP = 16_000; // keep the prompt bounded

/** Read the first present project-rules file under `cwd`, as a prompt block (or "" if none/unreadable). */
export function loadProjectRules(cwd: string): string {
  for (const name of PROJECT_RULE_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, name), "utf8");
    } catch {
      continue; // not present / unreadable → try the next candidate
    }
    const body = text.trim();
    if (!body) continue;
    const capped =
      body.length > PROJECT_RULES_CAP ? body.slice(0, PROJECT_RULES_CAP) + "\n…(truncated)" : body;
    return `Project rules (from ${name} — follow these for this project):\n${capped}`;
  }
  return "";
}
