// One-time, idempotent startup migrations. Zero deps (node:fs/path only). FAIL-SAFE: never lose data —
// on any error we keep the old file and skip. A manifest at <harnessDir>/.migration-manifest.json records
// completed migrations so each runs exactly once (and survives interrupts: a partial run just re-runs next time).

import fs from "node:fs";
import path from "node:path";
import { harnessDir, projectDir } from "../state/session.ts";

const MANIFEST_VERSION = 1;
const GLOBAL_TO_PERPROJECT = "global_to_perproject_v1";

interface Manifest {
  version: number;
  migrations: Record<string, string>; // key -> ISO timestamp
}

function manifestPath(): string {
  return path.join(harnessDir(), ".migration-manifest.json");
}

function readManifest(): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as Partial<Manifest>;
    if (m && typeof m === "object" && m.migrations && typeof m.migrations === "object") {
      return { version: m.version ?? MANIFEST_VERSION, migrations: m.migrations as Record<string, string> };
    }
  } catch {
    /* no/corrupt manifest → treat as empty */
  }
  return { version: MANIFEST_VERSION, migrations: {} };
}

function markDone(key: string): void {
  const m = readManifest();
  m.migrations[key] = new Date().toISOString();
  try {
    fs.mkdirSync(harnessDir(), { recursive: true });
    const file = manifestPath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: MANIFEST_VERSION, migrations: m.migrations }, null, 2), "utf8");
    fs.renameSync(tmp, file); // atomic
  } catch {
    /* best-effort; a failed mark just re-runs the (idempotent) migration next startup */
  }
}

/**
 * Migrate any LEGACY global store (from before approvals/memory became per-project) into THIS project's
 * per-project store. One-time (manifest-gated), idempotent, fail-safe. Returns a short notice if it moved
 * anything, else "". The legacy global files are LEFT in place (harmless; no longer read).
 *
 * Old global layout: <harnessDir>/permissions.json  ({allow:[…]})  and  <harnessDir>/memory.jsonl.
 * New per-project:   <projectDir(cwd)>/permissions.json  and  <projectDir(cwd)>/memory.jsonl.
 */
export function performStartupMigrations(cwd: string): string {
  if (readManifest().migrations[GLOBAL_TO_PERPROJECT]) return ""; // already migrated

  const globalPerms = path.join(harnessDir(), "permissions.json");
  const globalMem = path.join(harnessDir(), "memory.jsonl");
  if (!fs.existsSync(globalPerms) && !fs.existsSync(globalMem)) {
    markDone(GLOBAL_TO_PERPROJECT); // nothing to migrate (fresh install) — don't re-check every startup
    return "";
  }

  const dir = projectDir(cwd);
  const notices: string[] = [];

  // Approvals: copy the old {allow:[…]} into the per-project file, only if it doesn't exist yet.
  try {
    const dest = path.join(dir, "permissions.json");
    if (fs.existsSync(globalPerms) && !fs.existsSync(dest)) {
      const parsed = JSON.parse(fs.readFileSync(globalPerms, "utf8")) as { allow?: unknown };
      const allow = Array.isArray(parsed.allow) ? parsed.allow : [];
      if (allow.length > 0) {
        const tmp = `${dest}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, allow }, null, 2), "utf8");
        fs.renameSync(tmp, dest);
        notices.push(`${allow.length} saved approval(s)`);
      }
    }
  } catch {
    /* keep old file; skip */
  }

  // Memory: write the old JSONL lines into the per-project file, only if it doesn't exist yet. Use an ATOMIC
  // temp+rename (not appendFileSync) so a crash mid-write can't leave a partial memory.jsonl that the no-clobber
  // guard would then refuse to complete (silent data loss). The dest doesn't exist yet, so a full write is correct.
  try {
    const dest = path.join(dir, "memory.jsonl");
    if (fs.existsSync(globalMem) && !fs.existsSync(dest)) {
      const lines = fs.readFileSync(globalMem, "utf8").split("\n").filter((l) => l.trim());
      if (lines.length > 0) {
        const tmp = `${dest}.tmp`;
        fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
        fs.renameSync(tmp, dest); // atomic on one volume
        notices.push(`${lines.length} remembered fact(s)`);
      }
    }
  } catch {
    /* keep old file; skip */
  }

  markDone(GLOBAL_TO_PERPROJECT);
  return notices.length ? `migrated ${notices.join(" + ")} from the previous global store into this project` : "";
}
