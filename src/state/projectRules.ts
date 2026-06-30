// Optional per-project rules/instructions, loaded into the system prompt.
//
// Looks in the workspace (cwd) for a conventions file and returns its content as a prompt block
// (or "" if none / unreadable). Fail-safe + zero-dep (node:fs/path/crypto only). The content is treated as
// DATA by the model (the SYSTEM_PROMPT instructs it not to obey embedded directives), so a project
// file can set conventions ("answer in French", "use tabs") without becoming an injection vector.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PROJECT_RULE_FILES = [".qwen-harness.md", "AGENTS.md", ".qwenrules"];
const PROJECT_RULES_CAP = 16_000; // keep the prompt bounded

/** The first present, NON-EMPTY project-rules file under `cwd`: its name + raw content (or null). Single selection
 *  routine reused by loadProjectRules / findProjectRulesFile / projectRulesIdentity so they can never disagree. */
function selectProjectRules(cwd: string): { name: string; content: string } | null {
  for (const name of PROJECT_RULE_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, name), "utf8");
    } catch {
      continue; // not present / unreadable → try the next candidate
    }
    if (text.trim()) return { name, content: text }; // non-empty → this one wins (raw content, untrimmed)
  }
  return null;
}

/** The first present, NON-EMPTY project-rules file under `cwd` (its name), or null. */
export function findProjectRulesFile(cwd: string): string | null {
  return selectProjectRules(cwd)?.name ?? null;
}

/**
 * A2: the IDENTITY (name + SHA-256 of raw content) of the project-rules file that would load, or null. Workspace
 * trust is bound to this identity, so a different file winning the precedence (a monorepo subfolder) OR a content
 * swap at the same path (TOCTOU) no longer carries the trust granted for a different file — it re-prompts.
 */
export function projectRulesIdentity(cwd: string): { name: string; hash: string } | null {
  const sel = selectProjectRules(cwd);
  if (!sel) return null;
  return { name: sel.name, hash: createHash("sha256").update(sel.content).digest("hex") };
}

/** Read the first present project-rules file under `cwd`, as a prompt block (or "" if none/unreadable). */
export function loadProjectRules(cwd: string): string {
  const sel = selectProjectRules(cwd);
  if (!sel) return "";
  const body = sel.content.trim();
  const capped =
    body.length > PROJECT_RULES_CAP ? body.slice(0, PROJECT_RULES_CAP) + "\n…(truncated)" : body;
  return `Project rules (from ${sel.name} — follow these for this project):\n${capped}`;
}
