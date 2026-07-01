// autosuggest — PURE inline "ghost text" suggestion (SRP: pick the suffix; rendering lives in the controller). As you
// type, offer the most-recent history entry that extends what you've typed (fish/zsh strategy), falling back to a
// slash-command completion. Returns just the untyped SUFFIX (may be ""), which the controller draws dimmed after the
// caret and Right/End accepts. No I/O → unit-testable.

export function suggest(prefix: string, history: string[], commandNames: string[] = []): string {
  if (!prefix) return "";
  // 1) history: most-recent entry that strictly extends the current prefix
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.length > prefix.length && h.startsWith(prefix)) return h.slice(prefix.length);
  }
  // 2) slash-command completion: "/mo" → "de" (for /mode)
  if (prefix.startsWith("/") && !prefix.includes(" ")) {
    const q = prefix.slice(1).toLowerCase();
    if (q) {
      for (const name of commandNames) {
        if (name.length > q.length && name.toLowerCase().startsWith(q)) return name.slice(q.length);
      }
    }
  }
  return "";
}
