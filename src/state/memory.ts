// Long-term memory.
//
// Durable facts that survive across DIFFERENT chats (unlike a session, which is one
// conversation). Implemented simply:
//   - an append-only JSONL store under ~/.qwen-harness/memory.jsonl (override via
//     QWEN_HARNESS_DIR — shared with sessions);
//   - two tools the model can call: remember(fact) and recall(query?);
//   - recall injection: a "Known facts" block prepended to the system prompt on a
//     fresh conversation; the recall tool fetches on demand mid-conversation.
//
// Zero deps. The tools are readOnly:true for the PERMISSION gate because they only
// touch the harness's own memory store, never the user's workspace files.

import fs from "node:fs";
import path from "node:path";
import { harnessDir } from "../state/session.ts";
import type { Tool } from "../tools/tools.ts";

interface MemoryRecord {
  text: string;
  ts: string;
}

function memoryFile(): string {
  const dir = harnessDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.jsonl");
}

/** Save a durable fact. Trims and ignores empties. */
export function addMemory(text: string): boolean {
  const fact = text.trim();
  if (!fact) return false;
  const rec: MemoryRecord = { text: fact, ts: new Date().toISOString() };
  fs.appendFileSync(memoryFile(), JSON.stringify(rec) + "\n");
  return true;
}

/** All saved facts, oldest first. */
export function getMemories(): string[] {
  const file = memoryFile();
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as MemoryRecord;
      if (rec.text) out.push(rec.text);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Facts containing the query (case-insensitive); all facts if no query. */
export function searchMemories(query?: string): string[] {
  const all = getMemories();
  const q = (query ?? "").trim().toLowerCase();
  return q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
}

/** For tests: wipe the store. */
export function clearMemories(): void {
  const file = memoryFile();
  if (fs.existsSync(file)) fs.rmSync(file);
}

const MEMORY_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "it", "you",
  "your", "my", "me", "with", "this", "that", "be", "are", "was", "at", "as", "by", "i",
]);

/**
 * A "Known facts" block to prepend to a fresh system prompt (empty if none).
 *
 * Dedupes facts (case-insensitive, latest wins) and injects only the top-K, ranked by
 * relevance to `query` (keyword overlap) blended with recency. With no query it falls back
 * to the most-recent top-K. Keeps the prompt focused as the memory store grows.
 */
export function buildMemoryBlock(query?: string, topK = 12): string {
  const all = getMemories(); // oldest -> newest
  if (all.length === 0) return "";

  // Dedupe case-insensitively, keeping the latest occurrence (text + recency order).
  const byKey = new Map<string, { text: string; order: number }>();
  all.forEach((text, i) => {
    const key = text.trim().toLowerCase().replace(/\s+/g, " ");
    byKey.set(key, { text, order: i });
  });
  const deduped = [...byKey.values()].sort((a, b) => a.order - b.order);
  const m = deduped.length;
  if (m === 0) return "";

  const qTokens = [
    ...new Set(
      (query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !MEMORY_STOPWORDS.has(t)),
    ),
  ];

  const scored = deduped.map((d, i) => {
    const recencyScore = m <= 1 ? 1 : i / (m - 1); // newest = 1
    let overlap = 0;
    if (qTokens.length > 0) {
      const lower = d.text.toLowerCase();
      let matched = 0;
      for (const t of qTokens) if (lower.includes(t)) matched++;
      overlap = matched / qTokens.length;
    }
    return { text: d.text, recencyScore, score: overlap * 2 + recencyScore };
  });
  scored.sort((a, b) => b.score - a.score || b.recencyScore - a.recencyScore);

  const picked = scored.slice(0, Math.max(1, topK)).map((s) => s.text);
  return "Known facts you remembered earlier (use them; call recall for more):\n" + picked.map((f) => `- ${f}`).join("\n");
}

// ----------------------------- tools -----------------------------

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Save a durable fact to long-term memory so it is available in FUTURE chats (e.g. a user preference, a project detail). Use sparingly for things worth keeping.",
  readOnly: true, // touches only harness memory, not the workspace
  parameters: {
    type: "object",
    properties: { fact: { type: "string", description: "The fact to remember (one concise sentence)." } },
    required: ["fact"],
    additionalProperties: false,
  },
  async execute(args) {
    const fact = typeof args.fact === "string" ? args.fact : "";
    return addMemory(fact) ? `Remembered: ${fact.trim()}` : "Error: 'fact' must be a non-empty string.";
  },
};

export const recallTool: Tool = {
  name: "recall",
  description:
    "Search long-term memory for facts remembered in earlier chats. Omit query to list everything.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Optional keyword to filter facts." } },
    required: [],
    additionalProperties: false,
  },
  async execute(args) {
    const query = typeof args.query === "string" ? args.query : undefined;
    const hits = searchMemories(query);
    if (hits.length === 0) return query ? `No remembered facts match "${query}".` : "No facts remembered yet.";
    return hits.map((f) => `- ${f}`).join("\n");
  },
};
