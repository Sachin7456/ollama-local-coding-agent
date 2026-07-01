// One renderer for the agent's event stream — replaces the three near-duplicate printers in main.ts. PURE: it
// returns the string to print ("" = print nothing), so it's unit-testable and the I/O stays in main.ts.
// A `scope` prefixes worker lines (multi-agent); `streaming` means assistant TEXT was already written live via
// onToken, so we don't re-print it; `markdown` renders assistant answers through the markdown subset.

import type { AgentEvent } from "../agent/agent.ts";
import { type Theme, makeTheme } from "./theme.ts";
import { truncateToWidth } from "./width.ts";
import { renderMarkdown } from "./markdown.ts";
import { looksLikeDiff, renderDiff, diffStats, formatDiffStat } from "./diff.ts";
import { formatContextMeter } from "./meter.ts";

export interface RenderCtx {
  theme: Theme;
  cols: number;
  scope?: string;
  streaming?: boolean;
  markdown?: boolean;
  threshold?: number;
}

export function renderEvent(e: AgentEvent, ctx: RenderCtx): string {
  const t = ctx.theme ?? makeTheme(false);
  const prefix = ctx.scope && ctx.scope !== "orchestrator" ? `[${ctx.scope}] ` : "";
  const pfx = (s: string): string => (prefix ? s.split("\n").map((l) => prefix + l).join("\n") : s);

  if (e.type === "assistant") {
    if (e.toolCalls.length > 0) {
      return pfx(e.toolCalls.map((c) => t.tool(`  → ${c.function.name}(${JSON.stringify(c.function.arguments)})`)).join("\n"));
    }
    if (ctx.streaming) return ""; // text already streamed live
    const text = e.text.trim();
    if (!text) return "";
    return pfx("\n" + (ctx.markdown ? renderMarkdown(text, t, ctx.cols) : t.assistant(text)));
  }
  if (e.type === "tool_result") {
    if (looksLikeDiff(e.content)) {
      const { added, removed } = diffStats(e.content); // a +N -N summary above the diff
      return pfx(t.dim(`  ↳ ${e.tool} `) + formatDiffStat(added, removed, t) + "\n" + renderDiff(e.content, t));
    }
    const oneLine = e.content.replace(/\s+/g, " ");
    const room = Math.max(20, ctx.cols - 24);
    return pfx(t.toolResult(`  ↳ [${e.decision}] ${e.tool}: ${truncateToWidth(oneLine, room)}`));
  }
  if (e.type === "compaction") {
    const trimmed = e.truncatedChars ? `, trimmed ${e.truncatedChars} chars` : "";
    return pfx(t.dim(`  · compacted context (summarized ${e.summarized} msgs${trimmed}) to fit the window`));
  }
  if (e.type === "warning") {
    return pfx("\n" + t.warn(`⚠️  ${e.message}`));
  }
  if (e.type === "context") {
    const m = formatContextMeter(e.usedTokens, e.numCtx, ctx.threshold ?? 0.75, t);
    return m.warn ? pfx(`  ${m.line}`) : ""; // only surface as the window fills (quiet otherwise)
  }
  return ""; // done / reflection: handled elsewhere
}
