// NodeScreen — the real Screen: writes to stdout and moves/clears the cursor for transient-region repaints, using
// readline's cursor helpers (cursorTo/moveCursor/clearScreenDown). Only this module touches stdout cursor control
// (SRP). Append-only philosophy: we only ever repaint the CURRENT region (input/menu/spinner), never scrollback.

import readline from "node:readline";
import { stdout } from "node:process";
import type { Screen } from "./io.ts";

export class NodeScreen implements Screen {
  columns(): number {
    return stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  }
  rows(): number {
    return stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  }
  write(s: string): void {
    stdout.write(s);
  }
  clearBelow(): void {
    readline.cursorTo(stdout, 0);
    readline.clearScreenDown(stdout);
  }
  up(n: number): void {
    if (n > 0) readline.moveCursor(stdout, 0, -n);
  }
  hideCursor(): void {
    stdout.write("\x1b[?25l");
  }
  showCursor(): void {
    stdout.write("\x1b[?25h");
  }
}
