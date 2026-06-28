// Session persistence + resume.
//
// Append-only JSONL transcripts.
// Each session is one file: a `meta` line, then one `message` line per turn-message.
// Append-only => crash-safe and trivially resumable (replay the lines).
//
// Zero deps: node:fs/path/os/crypto only. Writes are synchronous appendFile so
// ordering is guaranteed and there are no interleaving races.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import type { ChatMessage } from "../model/ollamaClient.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  model?: string;
  cwd?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  messages: number;
  firstUser: string;
}

/** Base dir for harness state. Override with QWEN_HARNESS_DIR (used by tests). */
export function harnessDir(): string {
  return process.env.QWEN_HARNESS_DIR ?? path.join(os.homedir(), ".qwen-harness");
}

/** Nearest ancestor containing a `.git` entry (the project/repo root), or null. */
function gitRootOf(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}


export function projectKey(cwd: string): string {
  const root = gitRootOf(cwd) ?? path.resolve(cwd);
  const base = (path.basename(root).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)) || "project";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/** Per-project state dir under the harness dir (created on demand): <harnessDir>/projects/<projectKey>. */
export function projectDir(cwd: string): string {
  const dir = path.join(harnessDir(), "projects", projectKey(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Confirm a working dir still exists (e.g. a resumed session's original project may have been moved/deleted).
 * Returns the attempted dir if it's a real directory, else the fallback with `recovered: true` — so the caller
 * can warn cleanly instead of failing later with cryptic ENOENT/EACCES. Pure-ish (fs only) + unit-testable.
 */
export function validateAndRecoverCwd(attempted: string, fallback: string): { cwd: string; recovered: boolean } {
  try {
    if (fs.existsSync(attempted) && fs.statSync(attempted).isDirectory()) return { cwd: attempted, recovered: false };
  } catch {
    /* unreadable → treat as gone */
  }
  return { cwd: fallback, recovered: true };
}

export function sessionsDir(): string {
  const dir = path.join(harnessDir(), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${id}.jsonl`);
}

export class Session {
  readonly id: string;
  readonly file: string;
  readonly meta: SessionMeta;

  constructor(meta: SessionMeta) {
    this.id = meta.id;
    this.meta = meta;
    this.file = sessionFile(meta.id);
  }

  /** Start a brand-new session (writes the meta line). */
  static create(opts: { model?: string; cwd?: string; id?: string } = {}): Session {
    const meta: SessionMeta = {
      id: opts.id ?? randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      model: opts.model,
      cwd: opts.cwd,
    };
    const s = new Session(meta);
    fs.writeFileSync(s.file, JSON.stringify({ type: "meta", ...meta }) + "\n");
    return s;
  }

  /** Load a session's meta + reconstructed messages from disk. */
  static load(id: string): { meta: SessionMeta; messages: ChatMessage[] } {
    const file = sessionFile(id);
    if (!fs.existsSync(file)) throw new Error(`Session not found: ${id}`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    let meta: SessionMeta | null = null;
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // skip a corrupt/partial trailing line
      }
      if (e.type === "meta") {
        meta = { id: String(e.id), createdAt: String(e.createdAt), model: e.model as string | undefined, cwd: e.cwd as string | undefined };
      } else if (e.type === "message" && e.message) {
        messages.push(e.message as ChatMessage);
      }
    }
    return { meta: meta ?? { id, createdAt: "unknown" }, messages };
  }

  /** Reopen an existing session for appending. */
  static open(id: string): { session: Session; messages: ChatMessage[] } {
    const { meta, messages } = Session.load(id);
    return { session: new Session(meta), messages };
  }

  /** Append one message (synchronous => ordered + crash-safe). */
  appendMessage(message: ChatMessage): void {
    fs.appendFileSync(this.file, JSON.stringify({ type: "message", ts: new Date().toISOString(), message }) + "\n");
  }
}

/**
 * List saved sessions, newest first. Pass `filterByCwd` to show ONLY the sessions that belong to that project
 * (same `projectKey`), so the list isn't a global mix across every folder. Backward-compatible: no arg = all.
 */
export function listSessions(filterByCwd?: string): SessionSummary[] {
  const dir = sessionsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const wantKey = filterByCwd !== undefined ? projectKey(filterByCwd) : undefined;
  const out: SessionSummary[] = [];
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    try {
      const { meta, messages } = Session.load(id);
      if (wantKey !== undefined && (!meta.cwd || projectKey(meta.cwd) !== wantKey)) continue; // other project → skip
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      out.push({ id, createdAt: meta.createdAt, messages: messages.length, firstUser: firstUser.slice(0, 60) });
    } catch {
      if (wantKey === undefined) out.push({ id, createdAt: "?", messages: 0, firstUser: "" }); // unparseable: only when unfiltered
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}
