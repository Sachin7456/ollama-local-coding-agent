// Multi-agent orchestration that runs at most two model generations at once.
//
// Design:
//   - one shared Semaphore caps concurrent GENERATIONS at 2;
//   - the orchestrator (default 30B) decomposes work and calls `spawn_agents`;
//   - subagents (default 7B workers) run in PARALLEL but the gate ensures at most
//     2 are generating at any instant — extra ones queue;
//   - subagents cannot spawn (one level only), so no recursion / runaway.

import type { ModelClient } from "../model/modelClient.ts";
import {
  ToolRegistry,
  createFullRegistry,
  readFileTool,
  grepTool,
  ReadState,
  type Tool,
  type ToolContext,
} from "../tools/tools.ts";
import { PermissionEngine } from "../permissions/permissions.ts";
import { runAgent, type AgentEvent, type AgentResult, type AskHandler } from "../agent/agent.ts";
import type { ChatMessage } from "../model/ollamaClient.ts";
import type { CompactionOptions } from "../state/compaction.ts";
import { Semaphore } from "../orchestration/gate.ts";

const ORCHESTRATOR_PROMPT = `You are the ORCHESTRATOR. You coordinate a team of worker agents.
- For work that splits into INDEPENDENT subtasks, call spawn_agents with a list of clear, self-contained task strings. They run in parallel.
- You may read_file / grep yourself to understand the project before delegating.
- After the workers report back, synthesize ONE final answer (no tool call).
- Keep subtasks small and unambiguous; workers cannot see this conversation.`;

const WORKER_PROMPT = `You are a worker agent with a single, self-contained task.
- Use your tools (read_file/grep/write_file/edit_file/bash) to complete it.
- read_file a file before edit_file. Be concise.
- When done, reply with a short result summary (no tool call).`;

/** A8: append a trusted per-project rules block to a base system prompt (role framing first, rules last for recency). */
function withProjectRules(base: string, projectRules?: string): string {
  return projectRules ? `${base}\n\n${projectRules}` : base;
}

export interface OrchestratorDeps {
  client: ModelClient;
  permissions: PermissionEngine;
  /** shared workspace context for the orchestrator */
  ctx: ToolContext;
  /** the gate shared by orchestrator + all subagents (cap = 2) */
  gate: Semaphore;
  orchestratorModel: string;
  workerModel: string;
  onAsk?: AskHandler;
  /** scoped event observer: scope is "orchestrator" or "worker#N" */
  onEvent?: (scope: string, ev: AgentEvent) => void;
  maxWorkerTurns?: number;
  /** A8: trusted per-project rules block folded into the orchestrator + worker system prompts ("" / undefined = none). */
  projectRules?: string;
  /** abort the orchestrator AND all workers' in-flight requests (Ctrl+C / exit) */
  signal?: AbortSignal;
}

/**
 * The delegation tool. Spawns one worker per task; workers run concurrently but
 * the shared gate caps real concurrency at the semaphore's capacity (2).
 */
export function makeSpawnAgentsTool(deps: OrchestratorDeps): Tool {
  return {
    name: "spawn_agents",
    description:
      "Delegate INDEPENDENT subtasks to worker agents that run in parallel (at most 2 generating at once). Each worker has file/search/edit/bash tools and returns its result. Use for parallelizable work.",
    // Delegation itself is a control-plane action with no direct side effects —
    // every real effect is a worker's leaf tool call, which is permission-gated
    // inside that worker's loop. So the spawn is auto-allowed; safety lives at the leaves.
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Independent, self-contained subtask descriptions.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(args) {
      const tasks = Array.isArray(args.tasks) ? args.tasks.map((t) => String(t)).filter((t) => t.trim()) : [];
      if (tasks.length === 0) return "Error: 'tasks' must be a non-empty array of subtask strings.";

      const results = await Promise.all(
        tasks.map(async (task, i): Promise<string> => {
          // Each worker: worker model, full tools MINUS spawn (no recursion),
          // isolated read-state, but the SAME shared gate + workspace cwd.
          const subRegistry = createFullRegistry();
          const subCtx: ToolContext = { cwd: deps.ctx.cwd, readState: new ReadState() };
          let res: AgentResult;
          try {
            res = await runAgent({
              client: deps.client,
              registry: subRegistry,
              permissions: deps.permissions,
              ctx: subCtx,
              model: deps.workerModel,
              systemPrompt: withProjectRules(WORKER_PROMPT, deps.projectRules),
              userMessage: task,
              gate: deps.gate,
              onAsk: deps.onAsk,
              onEvent: deps.onEvent ? (ev) => deps.onEvent!(`worker#${i + 1}`, ev) : undefined,
              maxTurns: deps.maxWorkerTurns ?? 8,
              signal: deps.signal,
            });
          } catch (err) {
            return `### Subagent ${i + 1}\nFAILED: ${(err as Error).message}`;
          }
          const note = res.stopReason === "completed" ? "" : ` [${res.stopReason}]`;
          return `### Subagent ${i + 1}${note}\nTask: ${task}\nResult: ${res.text}`;
        }),
      );
      return results.join("\n\n");
    },
  };
}

/** The orchestrator's own toolset: look-around (read/grep) + delegation. */
export function makeOrchestratorRegistry(deps: OrchestratorDeps): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(grepTool)
    .register(makeSpawnAgentsTool(deps));
}

export async function runOrchestrator(opts: {
  task: string;
  deps: OrchestratorDeps;
  maxTurns?: number;
  /** resume the orchestrator's top-level conversation */
  priorMessages?: ChatMessage[];
  /** persist the orchestrator's top-level messages (workers stay ephemeral) */
  onMessage?: (msg: ChatMessage) => void;
  /** auto-compact the orchestrator's context near its window */
  compaction?: CompactionOptions;
}): Promise<AgentResult> {
  const { deps } = opts;
  return runAgent({
    client: deps.client,
    registry: makeOrchestratorRegistry(deps),
    permissions: deps.permissions,
    ctx: deps.ctx,
    model: deps.orchestratorModel,
    systemPrompt: withProjectRules(ORCHESTRATOR_PROMPT, deps.projectRules),
    userMessage: opts.task,
    gate: deps.gate,
    onAsk: deps.onAsk,
    onEvent: deps.onEvent ? (ev) => deps.onEvent!("orchestrator", ev) : undefined,
    maxTurns: opts.maxTurns ?? 10,
    priorMessages: opts.priorMessages,
    onMessage: opts.onMessage,
    compaction: opts.compaction,
    signal: deps.signal,
  });
}
