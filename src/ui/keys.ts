// NodeKeySource — the real KeySource: turns stdin into normalized Key events via readline.emitKeypressEvents +
// setRawMode, and implements BRACKETED PASTE (DEC mode 2004). Only this module touches raw-mode stdin (SRP).
// Guarded by isTTY: on a non-TTY stream start/stop are no-ops, so the caller falls back to the plain readline path.
//
// Bracketed paste: on start we ask the terminal to frame pastes (ESC[?2004h); the paste then arrives as
// ESC[200~ <content> ESC[201~. We accumulate everything between the markers and emit ONE paste event (not
// per-key), so pasted newlines/slashes can't trigger submit / the command palette. Standard xterm/ECMA-48 sequences.

import readline from "node:readline";
import { stdin, stdout } from "node:process";
import type { Key, KeySource } from "./io.ts";

const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_CAP = 5_000_000; // safety: flush a runaway paste (missing end marker)

export class NodeKeySource implements KeySource {
  private handlers = new Set<(k: Key) => void>();
  private pasteHandlers = new Set<(text: string) => void>();
  private active = false;
  private pasting = false;
  private pasteBuf = "";

  private flushPaste(): void {
    const text = this.pasteBuf.replace(/\r\n?/g, "\n"); // normalize CR / CRLF → LF
    this.pasting = false;
    this.pasteBuf = "";
    for (const h of [...this.pasteHandlers]) h(text);
  }

  private feedPaste(chunk: string): void {
    const end = chunk.indexOf(PASTE_END);
    if (end >= 0) {
      this.pasteBuf += chunk.slice(0, end);
      this.flushPaste();
    } else {
      this.pasteBuf += chunk;
      if (this.pasteBuf.length > PASTE_CAP) this.flushPaste();
    }
  }

  private readonly onKeypress = (str: string | undefined, key: KeypressKey | undefined): void => {
    const seq = key?.sequence ?? str ?? "";
    if (this.pasting) {
      this.feedPaste(seq);
      return;
    }
    const start = seq.indexOf(PASTE_START);
    if (start >= 0) {
      this.pasting = true;
      this.pasteBuf = "";
      this.feedPaste(seq.slice(start + PASTE_START.length));
      return;
    }
    const k: Key = {
      sequence: seq,
      name: key?.name,
      ctrl: Boolean(key?.ctrl),
      meta: Boolean(key?.meta),
      shift: Boolean(key?.shift),
    };
    for (const h of [...this.handlers]) h(k);
  };

  start(): void {
    if (this.active || !stdin.isTTY) return;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdout.write(PASTE_ENABLE);
    stdin.on("keypress", this.onKeypress);
    stdin.resume();
    this.active = true;
  }

  stop(): void {
    if (!this.active) return;
    stdin.off("keypress", this.onKeypress);
    if (stdin.isTTY) {
      stdout.write(PASTE_DISABLE);
      stdin.setRawMode(false);
    }
    this.active = false;
    this.pasting = false;
    this.pasteBuf = "";
  }

  onKey(handler: (k: Key) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onPaste(handler: (text: string) => void): () => void {
    this.pasteHandlers.add(handler);
    return () => this.pasteHandlers.delete(handler);
  }
}

// Node's readline keypress `key` shape (the fields we read).
interface KeypressKey {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}
