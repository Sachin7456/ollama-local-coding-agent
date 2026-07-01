// runSelect — a raw-mode, TYPE-TO-FILTER picker (rich mode) over the pure selectList reducer. ↑/↓ move, any printable
// char filters, Enter selects, Esc/Ctrl+C cancels → resolves the chosen value or null. Depends only on io.ts (DIP) so
// it's drivable headlessly with a fake KeySource/Screen. Backs the searchable /resume and /model pickers; the plain
// readline path keeps its numbered picker.

import type { KeySource, Screen, Key } from "./io.ts";
import type { Theme } from "./theme.ts";
import * as list from "./selectList.ts";
import { stringWidth } from "./width.ts";
import { searchBox } from "./box.ts";

export interface RunSelectDeps {
  keys: KeySource;
  screen: Screen;
  theme: Theme;
}

export function runSelect<T>(deps: RunSelectDeps, items: list.ListItem<T>[], title?: string): Promise<T | null> {
  const { keys, screen, theme } = deps;
  return new Promise<T | null>((resolve) => {
    let state = list.makeList(items);
    let lastRows = 0;

    const build = (): string => {
      const boxW = Math.min(Math.max(24, screen.columns() - 2), 72);
      const parts: string[] = [];
      if (title) parts.push(theme.accent(title));
      parts.push(searchBox(state.filter, boxW, theme)); // rounded ⌕ Search… box
      parts.push(list.renderList(state, theme));
      parts.push(theme.dim("↑/↓ move · type to filter · Enter select · Esc cancel"));
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
    const finish = (v: T | null): void => {
      if (done) return;
      done = true;
      unsub();
      keys.stop();
      screen.showCursor();
      screen.write("\n");
      resolve(v);
    };

    const onKey = (k: Key): void => {
      if (k.ctrl && k.name === "c") return finish(null);
      const r = list.applyKey(state, k); // ↑/↓ · type-to-filter · Enter · Esc
      if (r.cancelled) return finish(null);
      if (r.chosen !== undefined) return finish(r.chosen);
      state = r.state;
      paint();
    };

    const unsub = keys.onKey(onKey);
    keys.start();
    screen.hideCursor();
    paint();
  });
}
