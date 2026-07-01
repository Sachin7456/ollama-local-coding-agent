// UI I/O abstractions (SOLID: ISP + DIP). The interactive layer depends on these small interfaces — NOT on Node's
// tty/stdout directly — so the input controller, editor, menus and spinner are unit-testable with fakes (no real
// terminal). Concrete Node implementations live in keys.ts (KeySource) and screen.ts (Screen); tests supply fakes.

/** A normalized keypress (superset of Node's readline keypress `key` object). */
export interface Key {
  sequence: string; // raw bytes for this key (a printable char is its own sequence)
  name?: string; // "return" | "backspace" | "up" | "left" | "escape" | "a" | ... (undefined for some seqs)
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/** A source of key events (raw-mode). One job: turn stdin into normalized Key events. */
export interface KeySource {
  start(): void; // enable raw mode + keypress emission (no-op when not a TTY)
  stop(): void; // restore the terminal
  /** Subscribe to key events; returns an unsubscribe fn. */
  onKey(handler: (k: Key) => void): () => void;
  /** Subscribe to bracketed-paste blocks (whole paste as one string); returns an unsubscribe fn. */
  onPaste(handler: (text: string) => void): () => void;
}

/** A drawable surface. One job: write bytes + move/clear the cursor for transient-region repaints. */
export interface Screen {
  columns(): number;
  rows(): number;
  write(s: string): void;
  /** Move to column 0 and erase this row + everything below it (used before repainting a transient region). */
  clearBelow(): void;
  /** Move the cursor up `n` rows (0 = no-op). */
  up(n: number): void;
  hideCursor(): void;
  showCursor(): void;
}

/** Injectable time source (spinner elapsed + pause accounting) — keeps timing logic testable. */
export interface Clock {
  now(): number;
}
