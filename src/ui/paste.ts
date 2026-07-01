// paste — collapse a large paste to a placeholder and expand it back on submit. PURE + deterministic (a stateful
// store, but no I/O), so it's fully unit-testable. A big paste in the input buffer becomes "[Pasted text #N +K lines]"
// (kept short so the editor stays responsive); the full content lives in the store and is substituted back only when
// the message is submitted. Small pastes are inserted inline. Mirrors the "placeholder now, payload on submit" pattern.

export interface PasteEntry {
  id: number;
  text: string;
  lineCount: number;
  kind: "text" | "image";
}

export interface CollapseOpts {
  maxLines?: number; // collapse if more lines than this
  maxChars?: number; // …or longer than this
}

const PLACEHOLDER_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

export class PasteStore {
  private entries = new Map<number, PasteEntry>();
  private counter = 0;

  /** Decide inline-vs-placeholder for a pasted block. Returns the text to INSERT into the editor buffer. */
  add(text: string, opts: CollapseOpts = {}): { insert: string; entry?: PasteEntry } {
    const lineCount = text.split("\n").length;
    const big = lineCount > (opts.maxLines ?? 4) || text.length > (opts.maxChars ?? 200);
    if (!big) return { insert: text };
    const id = ++this.counter;
    const entry: PasteEntry = { id, text, lineCount, kind: "text" };
    this.entries.set(id, entry);
    return { insert: `[Pasted text #${id} +${lineCount} lines]`, entry };
  }

  /** Register a pasted image; returns the placeholder to show (payload retrievable via get()). */
  addImage(text: string): { insert: string; entry: PasteEntry } {
    const id = ++this.counter;
    const entry: PasteEntry = { id, text, lineCount: 1, kind: "image" };
    this.entries.set(id, entry);
    return { insert: `[Image #${id}]`, entry };
  }

  get(id: number): PasteEntry | undefined {
    return this.entries.get(id);
  }

  /** Substitute every "[Pasted text #N +K lines]" placeholder back to its full content (for submit). */
  expand(text: string): string {
    return text.replace(PLACEHOLDER_RE, (whole, idStr: string) => {
      const e = this.entries.get(Number(idStr));
      return e ? e.text : whole;
    });
  }

  /** Does the buffer still reference any stored paste? (e.g. to decide whether expand() is needed.) */
  hasRefs(text: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(text);
  }
}
