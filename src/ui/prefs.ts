// User preferences — a small JSON file under the harness dir (global, not per-project). Controls color, output
// verbosity, and default model/mode. Missing or malformed file → built-in defaults (never crashes the REPL).

import fs from "node:fs";
import path from "node:path";
import { harnessDir } from "../state/session.ts";
import type { ColorPref } from "./ansi.ts";

export type Verbosity = "quiet" | "normal" | "verbose";

export interface Prefs {
  color: ColorPref;
  verbosity: Verbosity;
  defaultMode?: string;
  defaultModel?: string;
}

export const DEFAULT_PREFS: Prefs = { color: "auto", verbosity: "normal" };

export function prefsPath(): string {
  return path.join(harnessDir(), "prefs.json");
}

const COLORS: ColorPref[] = ["auto", "always", "never"];
const VERBOSITIES: Verbosity[] = ["quiet", "normal", "verbose"];

/** Coerce arbitrary parsed JSON into a valid Prefs (defaults fill anything missing/invalid). Pure → testable. */
export function normalizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Prefs = { ...DEFAULT_PREFS };
  if (typeof o.color === "string" && (COLORS as string[]).includes(o.color)) out.color = o.color as ColorPref;
  if (typeof o.verbosity === "string" && (VERBOSITIES as string[]).includes(o.verbosity)) {
    out.verbosity = o.verbosity as Verbosity;
  }
  if (typeof o.defaultMode === "string" && o.defaultMode) out.defaultMode = o.defaultMode;
  if (typeof o.defaultModel === "string" && o.defaultModel) out.defaultModel = o.defaultModel;
  return out;
}

export function loadPrefs(): Prefs {
  try {
    return normalizePrefs(JSON.parse(fs.readFileSync(prefsPath(), "utf8")));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist prefs atomically (temp + rename) so a crash mid-write can't corrupt the file. */
export function savePrefs(p: Prefs): void {
  const file = prefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
}
