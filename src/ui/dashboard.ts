// dashboard — a PURE multi-agent status aggregator + renderer (SRP: aggregation + display; no I/O). Shows per-agent
// activity + token use and overall totals (total tokens, completed/total) for orchestrator / deep fan-out runs. The
// live pinned panel is wired later; this core is unit-testable — no terminal.

import { type Theme, makeTheme } from "./theme.ts";
import { compactTokens } from "./statusline.ts";

export interface AgentStat {
  label: string;
  tokens: number; // tokens used by this agent so far
  done: boolean;
}

export interface DashboardTotals {
  done: number;
  total: number;
  tokens: number;
}

export function dashboardTotals(agents: AgentStat[]): DashboardTotals {
  return {
    done: agents.filter((a) => a.done).length,
    total: agents.length,
    tokens: agents.reduce((sum, a) => sum + Math.max(0, a.tokens), 0),
  };
}

export function renderDashboard(agents: AgentStat[], theme: Theme = makeTheme(false)): string {
  const tot = dashboardTotals(agents);
  const header = theme.dim(`agents ${tot.done}/${tot.total} · ${compactTokens(tot.tokens)} tok total`);
  const rows = agents.map((a) => {
    const mark = a.done ? theme.ok("✓") : theme.accent("●");
    return `  ${mark} ${a.label}  ${theme.dim(`${compactTokens(a.tokens)} tok`)}`;
  });
  return [header, ...rows].join("\n");
}
