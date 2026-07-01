// Cross-session command history. Node's readline keeps history in-memory (newest-first) and emits a 'history'
// event whenever it changes; createInterface accepts a `history` seed. We glue those to a file under the harness
// dir so UP/DOWN (and free prefix-search) work across restarts. Best-effort: any fs error is swallowed — history
// must never crash or block the REPL. The on-disk file is oldest-first (one command per line, human-readable).

import fs from "node:fs";
import path from "node:path";
import { harnessDir } from "../state/session.ts";

export const HISTORY_MAX = 1000; // matches Node's REPL default

export function historyPath(): string {
  return path.join(harnessDir(), "history");
}

/** Read the on-disk history (oldest-first) and return it NEWEST-first, capped — ready for createInterface({history}). */
export function loadHistorySeed(max = HISTORY_MAX): string[] {
  try {
    const lines = fs
      .readFileSync(historyPath(), "utf8")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0);
    return lines.slice(-max).reverse(); // keep the newest `max`, hand back newest-first
  } catch {
    return [];
  }
}

/** Persist readline's history array (NEWEST-first) to disk (oldest-first), capped. Never throws. */
export function saveHistory(historyNewestFirst: string[], max = HISTORY_MAX): void {
  try {
    const oldestFirst = [...historyNewestFirst].reverse().slice(-max);
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, oldestFirst.length ? oldestFirst.join("\n") + "\n" : "");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/** Wire persistence: save whenever readline's history changes. (Seeding happens via createInterface({history}).) */
export function attachHistory(rl: { on: (event: string, cb: (h: string[]) => void) => void }, max = HISTORY_MAX): void {
  rl.on("history", (h) => saveHistory(h, max));
}
