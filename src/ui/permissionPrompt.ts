// permissionPrompt — the raw-mode ARROW-KEY approval dialog (rich mode). Reuses the pure selectList reducer over
// permissionChoices; ↑/↓ move, Enter selects, y=allow-once, a=always, n/Esc=deny. Depends only on io.ts interfaces
// (DIP) so it's drivable headlessly with a fake KeySource/Screen. The plain readline path keeps its y/a/N text prompt.

import type { KeySource, Screen, Key } from "./io.ts";
import type { Theme } from "./theme.ts";
import * as list from "./selectList.ts";
import { permissionChoices, type PermChoice } from "./permissionDialog.ts";
import { stringWidth } from "./width.ts";

export interface PermPromptDeps {
  keys: KeySource;
  screen: Screen;
  theme: Theme;
}

export interface PermPromptInfo {
  toolName: string;
  reason?: string;
  preview?: string; // e.g. the bash command, or a diff, shown above the choices
}

export function permissionPrompt(deps: PermPromptDeps, info: PermPromptInfo): Promise<PermChoice> {
  const { keys, screen, theme } = deps;
  return new Promise<PermChoice>((resolve) => {
    let state = list.makeList(permissionChoices(info.toolName));
    let lastRows = 0;

    const build = (): string => {
      const parts: string[] = [];
      parts.push(theme.warn(`Allow ${info.toolName}?`) + (info.reason ? theme.dim(`  (${info.reason})`) : ""));
      if (info.preview) parts.push(theme.dim(info.preview));
      parts.push(list.renderList(state, theme));
      parts.push(theme.dim("↑/↓ move · Enter select · y allow · a always · n/Esc deny"));
      return parts.join("\n");
    };
    const countRows = (content: string): number => {
      const cols = Math.max(1, screen.columns());
      let rows = 0;
      for (const line of content.split("\n")) rows += Math.max(1, Math.ceil(stringWidth(line) / cols));
      return rows;
    };
    const paint = (): void => {
      const content = build();
      if (lastRows > 0) {
        screen.up(lastRows - 1);
        screen.clearBelow();
      }
      screen.write(content);
      lastRows = countRows(content);
    };

    let done = false;
    const finish = (choice: PermChoice): void => {
      if (done) return;
      done = true;
      unsub();
      keys.stop();
      screen.showCursor();
      screen.write("\n");
      resolve(choice);
    };

    const onKey = (k: Key): void => {
      if (k.name === "y") return finish("allow");
      if (k.name === "a") return finish("always");
      if (k.name === "n" || k.name === "escape" || (k.ctrl && k.name === "c")) return finish("deny");
      const r = list.applyKey(state, k); // ↑/↓ navigate, Enter → chosen
      if (r.chosen !== undefined) return finish(r.chosen);
      if (r.cancelled) return finish("deny");
      state = r.state;
      paint();
    };

    const unsub = keys.onKey(onKey);
    keys.start();
    screen.hideCursor();
    paint();
  });
}
