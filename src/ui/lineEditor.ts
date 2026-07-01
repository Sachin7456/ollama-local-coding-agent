// lineEditor — a PURE multi-line input state machine (SRP: buffer editing only; no I/O). `applyKey` is a reducer, so
// it's trivially unit-testable with plain Key objects. Beyond basic editing it models the GNU-readline comforts:
// undo/redo (Ctrl+Z / Ctrl+_ / Ctrl+^), a kill-ring with yank (Ctrl+K/U/W → Ctrl+Y, rotate with Alt+Y), and word-wise
// move/kill (Ctrl+←/→, Ctrl+W, Alt+D, Alt+Backspace). All state is plain data → serializable + testable. Multi-line: a
// lone trailing "\" on Enter, or Ctrl+J, adds a line. History recall is the controller's job (we signal "prev"/"next").

import type { Key } from "./io.ts";

interface Snapshot {
  text: string;
  cursor: number;
}

export interface EditorState {
  text: string; // may contain "\n"
  cursor: number; // 0..text.length
  undo: Snapshot[]; // past states (oldest → newest)
  redo: Snapshot[]; // states undone (for redo)
  kill: string[]; // kill-ring, newest first
  lastOp: string; // "" | "insert" | "delete" | "kill" | "yank" | "nav" — for undo coalescing + kill concat
  yankAt: number; // start index of the last yank (for Alt+Y), -1 if none
}

const UNDO_CAP = 200;
const KILL_CAP = 60;

export function emptyEditor(): EditorState {
  return { text: "", cursor: 0, undo: [], redo: [], kill: [], lastOp: "", yankAt: -1 };
}

export function withText(text: string): EditorState {
  return { ...emptyEditor(), text, cursor: text.length };
}

export interface EditorResult {
  state: EditorState;
  submit?: string;
  history?: "prev" | "next";
}

function isPrintable(k: Key): boolean {
  return !k.ctrl && !k.meta && k.sequence.length === 1 && k.sequence >= " ";
}
function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}
function wordStart(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}
function wordEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && isSpace(text[i])) i++;
  while (i < text.length && !isSpace(text[i])) i++;
  return i;
}

/** Push the current text/cursor onto the undo stack (coalescing consecutive insert/delete runs) + clear redo. */
function withUndo(s: EditorState, op: string): Pick<EditorState, "undo" | "redo" | "lastOp"> {
  if (s.lastOp === op && (op === "insert" || op === "delete")) return { undo: s.undo, redo: [], lastOp: op };
  const undo = [...s.undo, { text: s.text, cursor: s.cursor }];
  if (undo.length > UNDO_CAP) undo.shift();
  return { undo, redo: [], lastOp: op };
}
/** Add killed text to the ring, concatenating with the previous kill if this is a consecutive kill. */
function withKill(s: EditorState, killed: string, dir: "fwd" | "back"): string[] {
  if (s.lastOp === "kill" && s.kill.length) {
    const merged = dir === "back" ? killed + s.kill[0] : s.kill[0] + killed;
    return [merged, ...s.kill.slice(1)];
  }
  return [killed, ...s.kill].slice(0, KILL_CAP);
}

/** Replace the whole buffer, pushing an undo snapshot (used by the controller for paste / @-mention insertion). */
export function replace(s: EditorState, text: string, cursor: number): EditorState {
  const undo = [...s.undo, { text: s.text, cursor: s.cursor }];
  if (undo.length > UNDO_CAP) undo.shift();
  return { ...s, text, cursor: Math.max(0, Math.min(text.length, cursor)), undo, redo: [], lastOp: "nav", yankAt: -1 };
}

export function applyKey(s: EditorState, k: Key): EditorResult {
  const name = k.name;

  // ---- undo / redo ----
  if ((k.ctrl && (name === "z" || name === "_")) || k.sequence === "\x1a" || k.sequence === "\x1f") {
    if (s.undo.length === 0) return { state: s };
    const prev = s.undo[s.undo.length - 1];
    return {
      state: { ...s, text: prev.text, cursor: prev.cursor, undo: s.undo.slice(0, -1), redo: [...s.redo, { text: s.text, cursor: s.cursor }], lastOp: "nav", yankAt: -1 },
    };
  }
  if (k.sequence === "\x1e" || (k.ctrl && name === "^")) {
    if (s.redo.length === 0) return { state: s };
    const nxt = s.redo[s.redo.length - 1];
    return {
      state: { ...s, text: nxt.text, cursor: nxt.cursor, redo: s.redo.slice(0, -1), undo: [...s.undo, { text: s.text, cursor: s.cursor }], lastOp: "nav", yankAt: -1 },
    };
  }

  // ---- submit / newline ----
  if (name === "return") {
    if (s.text.endsWith("\\")) {
      const text = s.text.slice(0, -1) + "\n";
      return { state: { ...s, ...withUndo(s, "insert"), text, cursor: text.length } };
    }
    return { state: s, submit: s.text };
  }
  if ((k.ctrl && name === "j") || k.sequence === "\n") {
    const text = s.text.slice(0, s.cursor) + "\n" + s.text.slice(s.cursor);
    return { state: { ...s, ...withUndo(s, "insert"), text, cursor: s.cursor + 1, yankAt: -1 } };
  }

  // ---- kill-ring: yank / rotate ----
  if (k.ctrl && name === "y") {
    if (s.kill.length === 0) return { state: s };
    const ins = s.kill[0];
    const text = s.text.slice(0, s.cursor) + ins + s.text.slice(s.cursor);
    return { state: { ...s, ...withUndo(s, "yank"), text, cursor: s.cursor + ins.length, lastOp: "yank", yankAt: s.cursor } };
  }
  if (k.meta && name === "y") {
    if (s.lastOp !== "yank" || s.kill.length < 2 || s.yankAt < 0) return { state: s };
    const prev = s.kill[0];
    const rotated = [...s.kill.slice(1), s.kill[0]];
    const ins = rotated[0];
    const text = s.text.slice(0, s.yankAt) + ins + s.text.slice(s.yankAt + prev.length);
    return { state: { ...s, kill: rotated, text, cursor: s.yankAt + ins.length, lastOp: "yank", yankAt: s.yankAt } };
  }

  // ---- word / line kills (feed the ring) ----
  if (k.ctrl && name === "k") {
    const killed = s.text.slice(s.cursor);
    if (!killed) return { state: { ...s, lastOp: "kill" } };
    return { state: { ...s, ...withUndo(s, "kill"), text: s.text.slice(0, s.cursor), kill: withKill(s, killed, "fwd"), lastOp: "kill", yankAt: -1 } };
  }
  if (k.ctrl && name === "u") {
    const killed = s.text.slice(0, s.cursor);
    if (!killed) return { state: { ...s, lastOp: "kill" } };
    return { state: { ...s, ...withUndo(s, "kill"), text: s.text.slice(s.cursor), cursor: 0, kill: withKill(s, killed, "back"), lastOp: "kill", yankAt: -1 } };
  }
  if ((k.ctrl && name === "w") || (k.meta && name === "backspace")) {
    const ws = wordStart(s.text, s.cursor);
    if (ws === s.cursor) return { state: { ...s, lastOp: "kill" } };
    const killed = s.text.slice(ws, s.cursor);
    return { state: { ...s, ...withUndo(s, "kill"), text: s.text.slice(0, ws) + s.text.slice(s.cursor), cursor: ws, kill: withKill(s, killed, "back"), lastOp: "kill", yankAt: -1 } };
  }
  if (k.meta && name === "d") {
    const we = wordEnd(s.text, s.cursor);
    if (we === s.cursor) return { state: { ...s, lastOp: "kill" } };
    const killed = s.text.slice(s.cursor, we);
    return { state: { ...s, ...withUndo(s, "kill"), text: s.text.slice(0, s.cursor) + s.text.slice(we), kill: withKill(s, killed, "fwd"), lastOp: "kill", yankAt: -1 } };
  }

  // ---- word / char movement (no undo) ----
  if ((k.ctrl || k.meta) && name === "left") return { state: { ...s, cursor: wordStart(s.text, s.cursor), lastOp: "nav" } };
  if ((k.ctrl || k.meta) && name === "right") return { state: { ...s, cursor: wordEnd(s.text, s.cursor), lastOp: "nav" } };
  if (name === "left") return { state: { ...s, cursor: Math.max(0, s.cursor - 1), lastOp: "nav" } };
  if (name === "right") return { state: { ...s, cursor: Math.min(s.text.length, s.cursor + 1), lastOp: "nav" } };
  if (name === "home" || (k.ctrl && name === "a")) return { state: { ...s, cursor: 0, lastOp: "nav" } };
  if (name === "end" || (k.ctrl && name === "e")) return { state: { ...s, cursor: s.text.length, lastOp: "nav" } };

  // ---- char delete ----
  if (name === "backspace") {
    if (s.cursor === 0) return { state: s };
    return { state: { ...s, ...withUndo(s, "delete"), text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1, yankAt: -1 } };
  }
  if (name === "delete") {
    if (s.cursor >= s.text.length) return { state: s };
    return { state: { ...s, ...withUndo(s, "delete"), text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), yankAt: -1 } };
  }

  // ---- history ----
  if (name === "up") return { state: s, history: "prev" };
  if (name === "down") return { state: s, history: "next" };

  // ---- printable insert ----
  if (isPrintable(k)) {
    return { state: { ...s, ...withUndo(s, "insert"), text: s.text.slice(0, s.cursor) + k.sequence + s.text.slice(s.cursor), cursor: s.cursor + 1, yankAt: -1 } };
  }
  return { state: s };
}

/** Display lines: `prompt` on the first line, a dim continuation gutter on wrapped lines. */
export function renderInput(s: EditorState, prompt: string, cont = "  "): string {
  return s.text.split("\n").map((l, i) => (i === 0 ? prompt : cont) + l).join("\n");
}
