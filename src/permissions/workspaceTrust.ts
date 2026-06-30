// Workspace trust (Help004 / A2) — best-effort, content-addressed.
//
// The ONLY untrusted in-repo content the harness loads is the project-rules file (.qwen-harness.md / AGENTS.md /
// .qwenrules) injected into the system prompt. Approvals / memory / sessions already live under the user dir
// (per-project), never the repo, so they need no trust gate. The decision is stored per-project at
// <harnessDir>/projects/<projectKey>/trust.json AND bound to the rules file's IDENTITY (name + SHA-256 of content):
// a different file (a monorepo subfolder shares the repo's projectKey) or a content swap at the same path (TOCTOU)
// no longer inherits trust — it re-prompts. Fail-safe: anything missing / unreadable / malformed / mismatched →
// untrusted. (Content-hash trust mirrors the VS Code / Mindgard "approve the bytes, not the path" pattern.)

import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../state/session.ts";

const TRUST_VERSION = 2; // v2 adds rulesFile + rulesHash; a v1 record (no identity) is treated as no-decision → re-prompt

/** Identity of the rules file a trust decision applies to (from `projectRulesIdentity`). */
export interface RulesIdentity {
  name: string;
  hash: string;
}

function trustPath(cwd: string): string {
  return path.join(projectDir(cwd), "trust.json");
}

interface TrustRecord {
  trusted: boolean;
  rulesFile?: string;
  rulesHash?: string;
}

/** Parse the stored record (fail-safe; requires a boolean `trusted`, else null). */
function readTrustRecord(cwd: string): TrustRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustPath(cwd), "utf8")) as Record<string, unknown>;
    if (typeof parsed.trusted !== "boolean") return null;
    return {
      trusted: parsed.trusted,
      rulesFile: typeof parsed.rulesFile === "string" ? parsed.rulesFile : undefined,
      rulesHash: typeof parsed.rulesHash === "string" ? parsed.rulesHash : undefined,
    };
  } catch {
    return null; // no file / unreadable / malformed → no decision on record
  }
}

/**
 * The stored decision, returned ONLY when it was recorded for the SAME rules identity (name + content hash) as
 * `current`. A different file, changed content, a missing identity, or a legacy v1 record → null → re-prompt.
 */
export function readTrustDecision(cwd: string, current: RulesIdentity | null): boolean | null {
  const rec = readTrustRecord(cwd);
  if (!rec) return null;
  if (!rec.rulesFile || !rec.rulesHash || !current) return null; // legacy / no identity → re-prompt (A2 migration)
  if (rec.rulesFile !== current.name || rec.rulesHash !== current.hash) return null; // different file / changed content
  return rec.trusted;
}

/** Persist this project's trust decision + the rules identity it applies to, atomically (temp+rename). False on failure. */
export function storeTrustDecision(cwd: string, trusted: boolean, current: RulesIdentity | null): boolean {
  let tmp = "";
  try {
    const file = trustPath(cwd);
    tmp = `${file}.tmp`;
    const payload = {
      version: TRUST_VERSION,
      trusted,
      rulesFile: current?.name ?? null,
      rulesHash: current?.hash ?? null,
      decidedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp); // don't leave a half-written temp file behind on failure
      } catch {
        /* nothing to clean up */
      }
    }
    return false;
  }
}

/** True only when this project has an explicit "trusted" decision on record for the current rules identity. */
export function isWorkspaceTrusted(cwd: string, current: RulesIdentity | null): boolean {
  return readTrustDecision(cwd, current) === true;
}
