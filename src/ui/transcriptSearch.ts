// transcriptSearch — PURE substring search across the conversation (SRP: matching; printing lives in main). Powers
// `/search <query>`: returns matching lines with their message index + role, so the user can find where something was
// said mid-session. Case-insensitive; skips non-text (tool/structured) content. No I/O → unit-testable.

export interface TranscriptMsg {
  role: string;
  content: unknown; // only string content is searched
}

export interface TranscriptMatch {
  index: number; // message index in the conversation
  role: string;
  line: string; // the matching line (trimmed)
}

export function searchTranscript(messages: TranscriptMsg[], query: string, max = 20): TranscriptMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TranscriptMatch[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m.content !== "string") continue;
    for (const raw of m.content.split("\n")) {
      if (raw.toLowerCase().includes(q)) {
        out.push({ index: i, role: m.role, line: raw.trim() });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
