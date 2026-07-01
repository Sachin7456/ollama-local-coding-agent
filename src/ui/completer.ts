// readline `completer` (Tab-autocomplete). Pure factory: takes a live model-tag lookup, returns the function
// readline calls. Completes slash-command tokens from the command registry, and model tags after "/model ".
// readline contract: return [matches[], substringBeingCompleted].

import { commandCompletions } from "./commands.ts";
import { fuzzyFilter } from "./fileMentions.ts";

export type Completer = (line: string) => [string[], string];

export function makeCompleter(getModelTags: () => string[], getFiles?: () => string[]): Completer {
  return (line: string): [string[], string] => {
    // "/model <partial>" → complete configured model tags.
    const m = /^\/model\s+(\S*)$/i.exec(line);
    if (m) {
      const partial = m[1];
      const tags = getModelTags();
      const hits = tags.filter((t) => t.startsWith(partial));
      return [hits.length ? hits : tags, partial];
    }
    // "@<partial>" as the last token → fuzzy-complete workspace file paths (keeps the leading @).
    const at = /(?:^|\s)(@\S*)$/.exec(line);
    if (at && getFiles) {
      const hits = fuzzyFilter(at[1].slice(1), getFiles(), 20).map((f) => "@" + f);
      return [hits, at[1]];
    }
    // A bare leading-slash token (no space yet) → complete command names/aliases.
    if (line.startsWith("/") && !line.includes(" ")) {
      const all = commandCompletions();
      const hits = all.filter((c) => c.startsWith(line));
      return [hits.length ? hits : all, line];
    }
    return [[], line];
  };
}
