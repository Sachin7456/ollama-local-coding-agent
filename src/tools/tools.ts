// Tool abstraction + registry + read-only built-in tools.
//
// Zero deps (node:fs/path only). Provides:
//   - the Tool interface + registry + JSON-Schema serialization
//   - read_file (line-numbered output) and grep (regex search) built-ins
//
// A Tool is a name + JSON-Schema + an async execute(). The registry turns the
// enabled tools into the `ToolDef[]` the OllamaClient sends to the model, and
// dispatches a model tool-call to the matching execute().

import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import type { ToolDef } from "../model/ollamaClient.ts";

/**
 * Tracks which files the agent has read (and their mtime at read time) so
 * edit_file can enforce the read-before-edit invariant + detect staleness
 * via a recorded read-state map.
 */
export class ReadState {
  private seen = new Map<string, number>();
  markRead(absPath: string, mtimeMs: number): void {
    this.seen.set(absPath, mtimeMs);
  }
  hasRead(absPath: string): boolean {
    return this.seen.has(absPath);
  }
  readMtime(absPath: string): number | undefined {
    return this.seen.get(absPath);
  }
}

export interface ToolContext {
  /** Workspace root; relative tool paths resolve against this. */
  cwd: string;
  /** Optional read-tracking for the read-before-edit invariant (CLI supplies one). */
  readState?: ReadState;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Read-only tools never mutate state — used by the permission gate. */
  readOnly: boolean;
  /** Run the tool; return the textual result that goes back to the model. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Serialize (a subset of) tools into the wire format the model receives. */
  toToolDefs(names?: string[]): ToolDef[] {
    const chosen = names
      ? names.map((n) => this.tools.get(n)).filter((t): t is Tool => Boolean(t))
      : this.list();
    return chosen.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** Dispatch a model tool-call by name. Returns the tool's textual result. */
  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: unknown tool "${name}".`;
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return `Error running ${name}: ${(err as Error).message}`;
    }
  }
}

// ----------------------------- helpers -----------------------------

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}
function asInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

const READ_MAX_LINES = 2000;
const GREP_MAX_RESULTS = 100;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_CONCURRENCY = 8;
// A NUL byte signals a binary file; built without a literal NUL in source.
const NULL_BYTE = String.fromCharCode(0);
const SKIP_DIRS = new Set([".git", "node_modules"]);

async function walkFiles(root: string, onFile: (abs: string) => Promise<boolean>): Promise<void> {
  // Iterative DFS. Stops early when onFile returns false.
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const keepGoing = await onFile(abs);
        if (!keepGoing) return;
      }
    }
  }
}

// ----------------------------- read_file -----------------------------

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file. Returns the content with 1-based line numbers (like `cat -n`). Use offset/limit for large files.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute." },
      offset: { type: "number", description: "1-based line number to start reading from." },
      limit: { type: "number", description: `Max lines to read (default ${READ_MAX_LINES}).` },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const rel = asString(args.path);
    if (!rel) return "Error: 'path' is required.";
    const abs = path.resolve(ctx.cwd, rel);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return `Error: file not found: ${rel}`;
      if (code === "EISDIR") return `Error: ${rel} is a directory, not a file.`;
      return `Error reading ${rel}: ${(err as Error).message}`;
    }
    // Record the read so edit_file can enforce read-before-edit.
    if (ctx.readState) {
      try {
        const st = await fs.stat(abs);
        ctx.readState.markRead(abs, st.mtimeMs);
      } catch {
        /* ignore */
      }
    }
    if (raw.length === 0) return "(empty file)";
    const lines = raw.split("\n");
    const offset = Math.max(1, asInt(args.offset) ?? 1);
    const limit = Math.max(1, asInt(args.limit) ?? READ_MAX_LINES);
    const start = offset - 1;
    const slice = lines.slice(start, start + limit);
    const out = slice
      .map((line, i) => `${String(start + i + 1).padStart(6, " ")}\t${line}`)
      .join("\n");
    const more =
      start + limit < lines.length ? `\n... (${lines.length - (start + limit)} more lines)` : "";
    return out + more;
  },
};

// ----------------------------- grep -----------------------------

// Scan ONE file and return all of its `rel:line: text` match lines (no cap here;
// the caller assembles + applies the cap). Returns [] on any skip/read error.
// Safe to run concurrently: `re` carries flags ""/"i" (never "g"), so re.test is stateless.
async function grepScanFile(abs: string, rel: string, re: RegExp): Promise<string[]> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    return [];
  }
  if (stat.size > GREP_MAX_FILE_BYTES) return [];
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    return [];
  }
  if (content.includes(NULL_BYTE)) return []; // skip binary files
  const out: string[] = [];
  const fileLines = content.split("\n");
  for (let i = 0; i < fileLines.length; i++) {
    if (re.test(fileLines[i])) {
      const text = fileLines[i].length > 300 ? fileLines[i].slice(0, 300) + "…" : fileLines[i];
      out.push(`${rel}:${i + 1}: ${text}`);
    }
  }
  return out;
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Searches a directory recursively (skips .git/node_modules/hidden) or a single file. Returns matching `path:line: text`.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search (default: workspace root)." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match." },
      maxResults: { type: "number", description: `Max matching lines to return (default ${GREP_MAX_RESULTS}).` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pattern = asString(args.pattern);
    if (!pattern) return "Error: 'pattern' is required.";
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.ignoreCase ? "i" : "");
    } catch (err) {
      return `Error: invalid regular expression: ${(err as Error).message}`;
    }
    const searchRoot = path.resolve(ctx.cwd, asString(args.path, "."));
    const cap = Math.max(1, asInt(args.maxResults) ?? GREP_MAX_RESULTS);

    let rootStat: import("node:fs").Stats;
    try {
      rootStat = await fs.stat(searchRoot);
    } catch {
      return `Error: path not found: ${asString(args.path, ".")}`;
    }

    // Enumerate files in stable DFS order (same traversal/skip rules as before).
    const files: string[] = [];
    if (rootStat.isFile()) {
      files.push(searchRoot);
    } else {
      await walkFiles(searchRoot, async (abs) => {
        files.push(abs);
        return true;
      });
    }

    // Scan with bounded concurrency. Keep per-file results so assembly is order-stable.
    // A contiguous-prefix counter lets us stop early once the first `cap` matches are fixed.
    const perFile: (string[] | undefined)[] = new Array(files.length);
    let next = 0;
    let done = false;
    let prefixIdx = 0;
    let prefixCount = 0;
    const advancePrefix = (): void => {
      while (prefixIdx < files.length && perFile[prefixIdx] !== undefined) {
        prefixCount += perFile[prefixIdx]!.length;
        prefixIdx++;
        if (prefixCount >= cap) {
          done = true;
          return;
        }
      }
    };
    const worker = async (): Promise<void> => {
      while (!done) {
        const idx = next++;
        if (idx >= files.length) return;
        const abs = files[idx];
        perFile[idx] = await grepScanFile(abs, path.relative(ctx.cwd, abs) || abs, re);
        advancePrefix();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(GREP_CONCURRENCY, Math.max(1, files.length)) }, () => worker()),
    );

    // Assemble the first `cap` matches in DFS file order (line order within each file).
    const results: string[] = [];
    for (let i = 0; i < files.length && results.length < cap; i++) {
      const lines = perFile[i];
      if (!lines) continue;
      for (const line of lines) {
        results.push(line);
        if (results.length >= cap) break;
      }
    }

    if (results.length === 0) return `No matches for /${pattern}/.`;
    const truncated = results.length >= cap ? `\n... (stopped at ${cap} matches)` : "";
    return results.join("\n") + truncated;
  },
};

// ----------------------------- write_file -----------------------------

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or OVERWRITE a file with the given content. Creates parent directories. For surgical changes to an existing file, prefer edit_file.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const rel = asString(args.path);
    if (!rel) return "Error: 'path' is required.";
    const content = asString(args.content);
    const abs = path.resolve(ctx.cwd, rel);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    } catch (err) {
      return `Error writing ${rel}: ${(err as Error).message}`;
    }
    if (ctx.readState) {
      try {
        const st = await fs.stat(abs);
        ctx.readState.markRead(abs, st.mtimeMs); // writing counts as "seen"
      } catch {
        /* ignore */
      }
    }
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}.`;
  },
};

// ----------------------------- edit_file -----------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const found = haystack.indexOf(needle, i);
    if (found === -1) break;
    count++;
    i = found + needle.length;
  }
  return count;
}

// Compare-only normalization: drop leading indentation + trailing whitespace/CR.
function normalizeWsLine(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
}

// Find start indices of line-windows in `fileLines` that equal `oldLines` after
// per-line whitespace normalization. Used only as a fallback when exact match fails.
function findWsTolerantWindows(fileLines: string[], oldLines: string[]): number[] {
  const L = oldLines.length;
  if (L === 0 || L > fileLines.length) return [];
  const normOld = oldLines.map(normalizeWsLine);
  const starts: number[] = [];
  for (let i = 0; i + L <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < L; k++) {
      if (normalizeWsLine(fileLines[i + k]) !== normOld[k]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact substring in an existing file. old_string must match EXACTLY ONCE (or set replace_all=true). You must read_file first. Copy old_string verbatim including whitespace/indentation.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit." },
      old_string: { type: "string", description: "Exact text to replace (must be unique unless replace_all)." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const rel = asString(args.path);
    const oldStr = asString(args.old_string);
    const newStr = asString(args.new_string);
    if (!rel) return "Error: 'path' is required.";
    if (oldStr.length === 0) return "Error: 'old_string' must be non-empty. To create a file use write_file.";
    if (oldStr === newStr) return "Error: 'old_string' and 'new_string' are identical; nothing to change.";
    const abs = path.resolve(ctx.cwd, rel);

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return `Error: file not found: ${rel}`;
      return `Error reading ${rel}: ${(err as Error).message}`;
    }

    // read-before-edit invariant + staleness check
    if (ctx.readState) {
      if (!ctx.readState.hasRead(abs)) {
        return `Error: you must read ${rel} with read_file before editing it.`;
      }
      try {
        const st = await fs.stat(abs);
        const seen = ctx.readState.readMtime(abs);
        if (seen !== undefined && st.mtimeMs > seen) {
          return `Error: ${rel} changed since you last read it. Read it again before editing.`;
        }
      } catch {
        /* ignore */
      }
    }

    const count = countOccurrences(content, oldStr);
    if (count === 0) {
      // Fallback: try a whitespace-tolerant (indentation/trailing-ws-insensitive) match.
      // Apply ONLY when it is unique — exact match is always preferred (handled above).
      const fileLines = content.split("\n");
      const oldLines = oldStr.split("\n");
      const starts = findWsTolerantWindows(fileLines, oldLines);
      if (starts.length === 1) {
        const i = starts[0];
        const rebuilt = [
          ...fileLines.slice(0, i),
          ...newStr.split("\n"),
          ...fileLines.slice(i + oldLines.length),
        ].join("\n");
        try {
          await fs.writeFile(abs, rebuilt, "utf8");
        } catch (err) {
          return `Error writing ${rel}: ${(err as Error).message}`;
        }
        if (ctx.readState) {
          try {
            const st = await fs.stat(abs);
            ctx.readState.markRead(abs, st.mtimeMs);
          } catch {
            /* ignore */
          }
        }
        return `Edited ${rel} (1 replacement, matched ignoring whitespace).`;
      }
      if (starts.length > 1) {
        return `Error: old_string not found exactly; a whitespace-insensitive match is ambiguous (${starts.length} candidates) in ${rel}. Provide more exact/surrounding text.`;
      }
      return `Error: old_string not found in ${rel}. Read the file and copy the exact text (including whitespace).`;
    }
    if (count > 1 && !args.replace_all) {
      return `Error: old_string appears ${count} times in ${rel}; it must be unique. Add surrounding context or set replace_all=true.`;
    }

    const updated = args.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    try {
      await fs.writeFile(abs, updated, "utf8");
    } catch (err) {
      return `Error writing ${rel}: ${(err as Error).message}`;
    }
    if (ctx.readState) {
      try {
        const st = await fs.stat(abs);
        ctx.readState.markRead(abs, st.mtimeMs);
      } catch {
        /* ignore */
      }
    }
    return `Edited ${rel} (${args.replace_all ? `${count} replacements` : "1 replacement"}).`;
  },
};

// ----------------------------- multi_edit -----------------------------

export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Apply SEVERAL exact-substring edits to ONE file atomically (all-or-nothing). You must read_file first. Each edit's old_string must match exactly once (or set replace_all). Later edits see earlier edits' results.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit." },
      edits: {
        type: "array",
        description: "Edits applied in order. Each: { old_string, new_string, replace_all? }.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace (unique unless replace_all)." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence." },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const rel = asString(args.path);
    if (!rel) return "Error: 'path' is required.";
    const edits = args.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return "Error: 'edits' must be a non-empty array of { old_string, new_string }.";
    }
    const abs = path.resolve(ctx.cwd, rel);

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return `Error: file not found: ${rel}`;
      return `Error reading ${rel}: ${(err as Error).message}`;
    }

    // read-before-edit invariant + staleness check (once for the whole batch).
    if (ctx.readState) {
      if (!ctx.readState.hasRead(abs)) {
        return `Error: you must read ${rel} with read_file before editing it.`;
      }
      try {
        const st = await fs.stat(abs);
        const seen = ctx.readState.readMtime(abs);
        if (seen !== undefined && st.mtimeMs > seen) {
          return `Error: ${rel} changed since you last read it. Read it again before editing.`;
        }
      } catch {
        /* ignore */
      }
    }

    // Apply edits in order into an in-memory string; abort (no write) on any failure.
    let working = content;
    let totalReplacements = 0;
    for (let n = 0; n < edits.length; n++) {
      const e = edits[n];
      if (!e || typeof e !== "object") return `Error: edit #${n + 1} must be an object. No changes written.`;
      const oldStr = asString((e as Record<string, unknown>).old_string);
      const newStr = asString((e as Record<string, unknown>).new_string);
      const replaceAll = Boolean((e as Record<string, unknown>).replace_all);
      if (oldStr.length === 0) return `Error: edit #${n + 1}: 'old_string' must be non-empty. No changes written.`;
      if (oldStr === newStr) return `Error: edit #${n + 1}: 'old_string' and 'new_string' are identical. No changes written.`;
      const c = countOccurrences(working, oldStr);
      if (c === 0) return `Error: edit #${n + 1}: old_string not found in ${rel} (after prior edits). No changes written.`;
      if (c > 1 && !replaceAll) {
        return `Error: edit #${n + 1}: old_string appears ${c} times in ${rel}; make it unique or set replace_all. No changes written.`;
      }
      working = replaceAll ? working.split(oldStr).join(newStr) : working.replace(oldStr, newStr);
      totalReplacements += replaceAll ? c : 1;
    }

    try {
      await fs.writeFile(abs, working, "utf8");
    } catch (err) {
      return `Error writing ${rel}: ${(err as Error).message}`;
    }
    if (ctx.readState) {
      try {
        const st = await fs.stat(abs);
        ctx.readState.markRead(abs, st.mtimeMs);
      } catch {
        /* ignore */
      }
    }
    return `Edited ${rel} (${edits.length} edits applied, ${totalReplacements} replacements).`;
  },
};

// ----------------------------- bash -----------------------------

const BASH_OUTPUT_CAP = 30000;

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number; killed?: boolean }) | null;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: e && typeof e.code === "number" ? e.code : e ? 1 : 0,
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace and return its output. Use for builds/tests/git/etc. NOT for reading or editing files (use read_file/edit_file).",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout: { type: "number", description: "Timeout in milliseconds (default 30000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const command = asString(args.command);
    if (!command) return "Error: 'command' is required.";
    const timeoutMs = Math.max(1000, asInt(args.timeout) ?? 30000);
    const { stdout, stderr, code, timedOut } = await runShell(command, ctx.cwd, timeoutMs);
    let out = stdout;
    if (stderr.trim()) out += `${out ? "\n" : ""}[stderr]\n${stderr}`;
    out = out.trim();
    if (out.length > BASH_OUTPUT_CAP) {
      out = out.slice(0, BASH_OUTPUT_CAP) + `\n... (output truncated at ${BASH_OUTPUT_CAP} chars)`;
    }
    const head = timedOut ? `timed out after ${timeoutMs}ms; ` : "";
    return `${head}exit code: ${code}\n${out || "(no output)"}`;
  },
};

/** A registry with the read-only built-ins only. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry().register(readFileTool).register(grepTool);
}

/** A registry with all built-ins, including mutating tools (write/edit/bash). */
export function createFullRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(grepTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(multiEditTool)
    .register(bashTool);
}
