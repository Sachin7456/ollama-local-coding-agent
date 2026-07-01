// inputController — the raw-mode REPL input orchestrator. Ties the injected KeySource + Screen to the PURE reducers
// (lineEditor, selectList, reverseSearch) and the affordances (/ palette, @ mentions). Returns the submitted line
// (or cancel/eof). DIP: depends only on io.ts interfaces, so it's swappable/fake-able. The interactive redraw itself
// isn't unit-tested (real TTY) — the correctness lives in the pure reducers; this is thin orchestration + repaint.
//
// Limitations (documented): the terminal cursor sits at the end of the region (edits are correct; caret is not
// repositioned mid-line). Callers guard with isTTY and can fall back to plain readline (QWEN_HARNESS_PLAIN_INPUT=1).

import type { KeySource, Screen, Key } from "./io.ts";
import type { Theme } from "./theme.ts";
import * as editor from "./lineEditor.ts";
import * as list from "./selectList.ts";
import * as mentions from "./fileMentions.ts";
import * as rsearch from "./reverseSearch.ts";
import { paletteItems } from "./palette.ts";
import type { CommandSpec } from "./commands.ts";
import { stringWidth } from "./width.ts";
import { PasteStore } from "./paste.ts";
import { suggest } from "./autosuggest.ts";

export interface InputDeps {
  keys: KeySource;
  screen: Screen;
  theme: Theme;
}

export interface InputOptions {
  prompt: string;
  statusLine?: string;
  history: string[]; // newest-first
  files: () => string[]; // lazy workspace file list for @ (caller caches)
  onModeCycle?: () => string; // Shift+Tab → cycle permission mode; returns the fresh status line to show
}

export type InputOutcome = { kind: "submit"; text: string } | { kind: "cancel" } | { kind: "eof" };

type Overlay =
  | { type: "none" }
  | { type: "palette"; state: list.ListState<CommandSpec> }
  | { type: "argmenu"; name: string; state: list.ListState<string> }
  | { type: "mention"; state: list.ListState<string> }
  | { type: "search"; state: rsearch.SearchState };

export function readInput(deps: InputDeps, opts: InputOptions): Promise<InputOutcome> {
  const { keys, screen, theme } = deps;
  return new Promise<InputOutcome>((resolve) => {
    let ed = editor.emptyEditor();
    let overlay: Overlay = { type: "none" };
    let histCursor = -1; // -1 = editing the live draft
    let draft = "";
    let lastRows = 0;
    let statusLine = opts.statusLine; // mutable so Shift+Tab can refresh the mode badge live
    const pasteStore = new PasteStore(); // bracketed pastes collapse to placeholders, expand on submit

    const countRows = (content: string): number => {
      const cols = Math.max(1, screen.columns());
      let rows = 0;
      for (const line of content.split("\n")) rows += Math.max(1, Math.ceil(stringWidth(line) / cols));
      return rows;
    };
    const build = (): string => {
      const parts: string[] = [];
      if (statusLine) parts.push(statusLine);
      const inputLine = editor.renderInput(ed, opts.prompt);
      // fish-style ghost text: dim history suggestion after the caret (only with no overlay + caret at end)
      const ghost = overlay.type === "none" && ed.cursor === ed.text.length ? suggest(ed.text, opts.history).split("\n")[0] : "";
      parts.push(ghost ? inputLine + theme.dim(ghost) : inputLine);
      if (overlay.type === "palette" || overlay.type === "mention" || overlay.type === "argmenu") {
        parts.push(list.renderList(overlay.state, theme));
      } else if (overlay.type === "search") parts.push(rsearch.renderSearch(overlay.state, opts.history, theme));
      return parts.join("\n");
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
    const finish = (outcome: InputOutcome): void => {
      if (done) return;
      done = true;
      unsub();
      unsubPaste();
      keys.stop();
      screen.showCursor();
      screen.write("\n");
      // expand any "[Pasted text #N]" placeholders back to their full content before handing the text off.
      const out: InputOutcome = outcome.kind === "submit" ? { kind: "submit", text: pasteStore.expand(outcome.text) } : outcome;
      resolve(out);
    };

    const syncPalette = (): void => {
      if (/^\/[^\s]*$/.test(ed.text)) {
        overlay = { type: "palette", state: { items: paletteItems(), filter: ed.text.slice(1), index: 0 } };
      } else if (overlay.type === "palette") overlay = { type: "none" };
    };
    const syncMention = (): void => {
      const m = mentions.mentionQuery(ed.text, ed.cursor);
      if (m) {
        const items = mentions.fuzzyFilter(m.query, opts.files(), 8).map((f) => ({ label: f, value: f }));
        overlay = { type: "mention", state: { items, filter: "", index: 0 } };
      } else if (overlay.type === "mention") overlay = { type: "none" };
    };

    const recallPrev = (): void => {
      if (!opts.history.length) return;
      if (histCursor === -1) draft = ed.text;
      histCursor = Math.min(histCursor + 1, opts.history.length - 1);
      ed = editor.withText(opts.history[histCursor]);
    };
    const recallNext = (): void => {
      if (histCursor < 0) return;
      histCursor -= 1;
      ed = editor.withText(histCursor === -1 ? draft : opts.history[histCursor]);
    };

    const onKey = (k: Key): void => {
      if (k.ctrl && k.name === "c") return finish({ kind: "cancel" });
      if (k.ctrl && k.name === "d" && ed.text === "") return finish({ kind: "eof" });
      // Shift+Tab (CBT \x1b[Z → {name:"tab",shift:true}) cycles the permission mode live, keeping the typed buffer.
      if (k.name === "tab" && k.shift) {
        if (opts.onModeCycle) {
          statusLine = opts.onModeCycle();
          paint();
        }
        return;
      }

      // --- palette overlay ---
      if (overlay.type === "palette") {
        if (k.name === "up" || k.name === "down" || k.name === "return" || k.name === "escape") {
          const r = list.applyKey(overlay.state, k);
          if (r.cancelled) {
            overlay = { type: "none" };
            return paint();
          }
          if (r.chosen) {
            const spec = r.chosen;
            if (spec.options && spec.options.length > 0) {
              // open a submenu of the command's choosable argument values
              overlay = { type: "argmenu", name: spec.name, state: list.makeList(spec.options.map((o) => ({ label: o, value: o }))) };
              return paint();
            }
            if (spec.usage) {
              ed = editor.withText(`/${spec.name} `); // free-text args → drop into the buffer
              overlay = { type: "none" };
              return paint();
            }
            return finish({ kind: "submit", text: `/${spec.name}` }); // no-arg → run now
          }
          overlay = { type: "palette", state: r.state };
          return paint();
        }
        ed = editor.applyKey(ed, k).state; // typing edits the "/query" buffer
        syncPalette();
        return paint();
      }

      // --- argument submenu (a command's choosable values) ---
      if (overlay.type === "argmenu") {
        const r = list.applyKey(overlay.state, k); // handles arrows / typing-filter / Enter / Esc
        if (r.cancelled) {
          overlay = { type: "none" };
          return paint();
        }
        if (r.chosen !== undefined) return finish({ kind: "submit", text: `/${overlay.name} ${r.chosen}` });
        overlay = { type: "argmenu", name: overlay.name, state: r.state };
        return paint();
      }

      // --- @-mention overlay ---
      if (overlay.type === "mention") {
        if (k.name === "up" || k.name === "down" || k.name === "return" || k.name === "escape") {
          const r = list.applyKey(overlay.state, k);
          if (r.cancelled) {
            overlay = { type: "none" };
            return paint();
          }
          if (r.chosen) {
            const mm = mentions.applyMention(ed.text, ed.cursor, r.chosen);
            ed = editor.replace(ed, mm.text, mm.cursor);
            overlay = { type: "none" };
            return paint();
          }
          overlay = { type: "mention", state: r.state };
          return paint();
        }
        ed = editor.applyKey(ed, k).state;
        syncMention();
        return paint();
      }

      // --- reverse-search overlay ---
      if (overlay.type === "search") {
        const r = rsearch.applyKey(overlay.state, k, opts.history);
        if (r.cancel) {
          overlay = { type: "none" };
          return paint();
        }
        if (r.accept !== undefined) {
          ed = editor.withText(r.accept);
          overlay = { type: "none" };
          return paint();
        }
        overlay = { type: "search", state: r.state };
        return paint();
      }

      // --- no overlay ---
      if (k.ctrl && k.name === "r") {
        overlay = { type: "search", state: rsearch.makeSearch() };
        return paint();
      }
      // accept the ghost-text suggestion: Right/End at end of buffer
      if ((k.name === "right" || k.name === "end") && ed.cursor === ed.text.length) {
        const g = suggest(ed.text, opts.history).split("\n")[0];
        if (g) {
          ed = editor.replace(ed, ed.text + g, ed.text.length + g.length);
          return paint();
        }
      }
      const r = editor.applyKey(ed, k);
      if (r.submit !== undefined) return finish({ kind: "submit", text: r.submit });
      if (r.history === "prev") {
        recallPrev();
        return paint();
      }
      if (r.history === "next") {
        recallNext();
        return paint();
      }
      ed = r.state;
      histCursor = -1;
      syncPalette();
      if (overlay.type === "none") syncMention();
      return paint();
    };

    const unsub = keys.onKey(onKey);
    const unsubPaste = keys.onPaste((text) => {
      const { insert } = pasteStore.add(text); // large paste → "[Pasted text #N +K lines]" placeholder
      ed = editor.replace(ed, ed.text.slice(0, ed.cursor) + insert + ed.text.slice(ed.cursor), ed.cursor + insert.length);
      histCursor = -1;
      syncPalette();
      if (overlay.type === "none") syncMention();
      paint();
    });
    keys.start();
    screen.hideCursor();
    paint();
  });
}
