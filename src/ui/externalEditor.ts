// externalEditor — compose a message in $EDITOR (/editor, Ctrl-X Ctrl-E). Writes a temp file, spawns the editor
// with inherited stdio, reads it back, and cleans up. Thin I/O (SRP). Falls back to notepad (Windows) / vi.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function editInEditor(initial = ""): string {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  const file = path.join(os.tmpdir(), `qwen-harness-${process.pid}-${Date.now()}.md`);
  try {
    fs.writeFileSync(file, initial);
    spawnSync(editor, [file], { stdio: "inherit", shell: process.platform === "win32" });
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore cleanup errors */
    }
  }
}
