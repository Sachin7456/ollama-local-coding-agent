// main.ts — the CLI entry. Wires client + tools + permissions + loop.
//
//   npm start                         interactive REPL (default model)
//   npm start -- "fix the bug in x"   one-shot task
//   npm start -- --model qwen3-coder:30b "..."   switch model
//   npm start -- --mode acceptEdits "..."        change permission mode
//
// Provides the interactive REPL with terminal permission prompts + config wiring.

import "../cli/loadEnv.ts"; // MUST be first: load .env into process.env before config is read
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { OllamaClient } from "../model/ollamaClient.ts";
import { createFullRegistry, ReadState, type ToolContext } from "../tools/tools.ts";
import { createDefaultPermissions, type PermissionMode } from "../permissions/permissions.ts";
import { runAgent, type AgentEvent, type AskInfo } from "../agent/agent.ts";
import { resolveModel, resolveWorkerModel, fileRegistryModels, getModels, OLLAMA_BASE_URL } from "../model/config.ts";
import { preflight, formatPreflight } from "../cli/preflight.ts";
import { Semaphore } from "../orchestration/gate.ts";
import { runOrchestrator } from "../orchestration/orchestrator.ts";
import { Session, listSessions } from "../state/session.ts";
import { rememberTool, recallTool, buildMemoryBlock } from "../state/memory.ts";
import { makeListModelsTool } from "../model/listModelsTool.ts";
import type { ChatMessage } from "../model/ollamaClient.ts";

const SYSTEM_PROMPT = `You are a coding assistant working in a local project directory.
You have tools: read_file, grep, write_file, edit_file, multi_edit, bash, list_models.
Rules:
- To inspect or change files you MUST use the tools — never guess file contents.
- Always read_file a file before you edit_file/multi_edit it; copy text verbatim.
- For several changes to one file in a single step, prefer multi_edit (atomic).
- To see which models are installed locally, use list_models (don't guess).
- Use bash to run shell commands — builds, tests, git, and environment/system queries (e.g. \`ollama list\`, \`node -v\`) — but not for reading or editing files.
- Be concise. When the task is finished, reply with a 1-2 sentence summary (no tool call).`;

interface CliArgs {
  model?: string;
  worker?: string;
  task?: string;
  mode: PermissionMode;
  multi: boolean;
  resume?: string;
  listSessions: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let model: string | undefined;
  let worker: string | undefined;
  let mode: PermissionMode = "default";
  let multi = false;
  let resume: string | undefined;
  let listSessions = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") model = argv[++i];
    else if (a === "--worker") worker = argv[++i];
    else if (a === "--mode") mode = argv[++i] as PermissionMode;
    else if (a === "--multi") multi = true;
    else if (a === "--resume" || a === "-r") resume = argv[++i];
    else if (a === "--list-sessions") listSessions = true;
    else rest.push(a);
  }
  return { model, worker, task: rest.join(" ").trim() || undefined, mode, multi, resume, listSessions };
}

function printEvent(e: AgentEvent): void {
  if (e.type === "assistant") {
    if (e.toolCalls.length > 0) {
      for (const c of e.toolCalls) {
        console.log(`  → ${c.function.name}(${JSON.stringify(c.function.arguments)})`);
      }
    } else if (e.text.trim()) {
      console.log(`\n${e.text.trim()}`);
    }
  } else if (e.type === "tool_result") {
    const oneLine = e.content.replace(/\s+/g, " ").slice(0, 100);
    console.log(`  ↳ [${e.decision}] ${e.tool}: ${oneLine}`);
  }
}

/** Scoped printer for multi-agent mode (prefixes worker lines). */
function printScoped(scope: string, e: AgentEvent): void {
  const tag = scope === "orchestrator" ? "" : `[${scope}] `;
  if (e.type === "assistant") {
    if (e.toolCalls.length > 0) {
      for (const c of e.toolCalls) console.log(`${tag}  → ${c.function.name}(${JSON.stringify(c.function.arguments)})`);
    } else if (e.text.trim()) {
      console.log(`\n${tag}${e.text.trim()}`);
    }
  } else if (e.type === "tool_result") {
    const oneLine = e.content.replace(/\s+/g, " ").slice(0, 100);
    console.log(`${tag}  ↳ [${e.decision}] ${e.tool}: ${oneLine}`);
  } else if (e.type === "compaction") {
    const trimmed = e.truncatedChars ? `, trimmed ${e.truncatedChars} chars` : "";
    console.log(`${tag}  · compacted context (summarized ${e.summarized} msgs${trimmed}) to fit the window`);
  }
}

/** Streaming printer: assistant text is already written live via onToken. */
function printEventStreaming(e: AgentEvent): void {
  if (e.type === "assistant") {
    process.stdout.write("\n"); // close the streamed line
    if (e.toolCalls.length > 0) {
      for (const c of e.toolCalls) console.log(`  → ${c.function.name}(${JSON.stringify(c.function.arguments)})`);
    }
  } else if (e.type === "tool_result") {
    const oneLine = e.content.replace(/\s+/g, " ").slice(0, 100);
    console.log(`  ↳ [${e.decision}] ${e.tool}: ${oneLine}`);
  } else if (e.type === "compaction") {
    const trimmed = e.truncatedChars ? `, trimmed ${e.truncatedChars} chars` : "";
    console.log(`  · compacted context (summarized ${e.summarized} msgs${trimmed}) to fit the window`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.listSessions) {
    const sessions = listSessions();
    if (sessions.length === 0) console.log("No saved sessions.");
    else for (const s of sessions) console.log(`${s.id}  ${s.createdAt}  (${s.messages} msgs)  ${s.firstUser}`);
    return;
  }

  const model = resolveModel(args.model);
  const client = new OllamaClient();
  const registry = createFullRegistry()
    .register(rememberTool)
    .register(recallTool)
    .register(makeListModelsTool(client));
  const permissions = createDefaultPermissions(args.mode);
  const ctx: ToolContext = { cwd: process.cwd(), readState: new ReadState() };
  let activeModel = model.name;
  // Worker model for multi-agent — REGISTRY-DRIVEN (works with any installed model, not hardcoded).
  const workerModel = resolveWorkerModel(args.worker).name;

  // One-time preflight: verify prerequisites (Node, Ollama, required models) with
  // actionable guidance. Runs ONCE at startup only — no per-turn latency.
  const requiredModels = args.multi ? [...new Set([activeModel, workerModel])] : [activeModel];
  const pf = await preflight({ baseUrl: OLLAMA_BASE_URL, requiredModels, optionalModels: fileRegistryModels() });
  if (!pf.ok) {
    console.error(formatPreflight(pf));
    process.exit(1);
  }
  for (const w of pf.warnings) console.warn(`⚠️  ${w}`);

  // Session persistence: resume an existing transcript or start a fresh one.
  let history: ChatMessage[] = [];
  let session: Session;
  if (args.resume) {
    const opened = Session.open(args.resume);
    session = opened.session;
    history = opened.messages;
    console.log(`resumed session ${session.id} (${history.length} messages)`);
  } else {
    session = Session.create({ model: activeModel, cwd: ctx.cwd });
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const onAsk = async (info: AskInfo): Promise<boolean> => {
    const ans = (
      await rl.question(`\n⚠️  Allow ${info.toolName}(${JSON.stringify(info.args)})?  [${info.reason}]  (y/N) `)
    )
      .trim()
      .toLowerCase();
    return ans === "y" || ans === "yes";
  };

  // Shared 2-permit gate for multi-agent mode (orchestrator + workers).
  const gate = new Semaphore(2);

  // Tracks the in-flight request so Ctrl+C can abort it (and stop Ollama generating).
  let activeAbort: AbortController | null = null;
  process.on("SIGINT", () => {
    if (activeAbort) {
      activeAbort.abort(); // a request is running → cancel it; the loop returns to the prompt
      console.log("\n(request cancelled)");
    } else {
      console.log("\n(bye)");
      rl.close();
      process.exit(0);
    }
  });

  async function runTask(text: string): Promise<void> {
    const priorMessages = history.length > 0 ? history : undefined;
    const onMessage = (m: ChatMessage): void => session.appendMessage(m);
    const compaction = { numCtx: resolveModel(activeModel).numCtx, threshold: 0.75, keepRecent: 8, toolResultCap: 2000 };
    const memBlock = buildMemoryBlock(text);
    const sysPrompt = memBlock ? `${SYSTEM_PROMPT}\n\n${memBlock}` : SYSTEM_PROMPT;
    const ac = new AbortController();
    activeAbort = ac;
    try {
      const res = args.multi
        ? await runOrchestrator({
            task: text,
            deps: {
              client,
              permissions,
              ctx,
              gate,
              orchestratorModel: activeModel,
              workerModel,
              onAsk,
              onEvent: printScoped,
              maxWorkerTurns: 10,
              signal: ac.signal,
            },
            maxTurns: 12,
            priorMessages,
            onMessage,
            compaction,
          })
        : await runAgent({
            client,
            registry,
            permissions,
            ctx,
            model: activeModel,
            systemPrompt: sysPrompt,
            userMessage: text,
            onAsk,
            stream: true,
            onToken: (c) => process.stdout.write(c),
            onEvent: printEventStreaming,
            maxTurns: 12,
            priorMessages,
            onMessage,
            compaction,
            signal: ac.signal,
          });
      history = res.messages; // carry the conversation forward (and it's persisted)
      if (res.stopReason !== "completed") console.log(`\n[stopped: ${res.stopReason}]`);
    } finally {
      activeAbort = null;
    }
  }

  // One-shot mode.
  if (args.task) {
    await runTask(args.task);
    console.log(`\n(session ${session.id} — resume: npm start -- --resume ${session.id})`);
    rl.close();
    return;
  }

  // Interactive REPL.
  const modeLabel = args.multi ? `multi-agent (orch=${activeModel}, worker=${workerModel}, cap=2)` : `single (${activeModel})`;
  console.log(`qwen-harness  —  ${modeLabel}  |  perms: ${permissions.mode}  |  cwd: ${ctx.cwd}`);
  console.log(`session: ${session.id}   (resume later:  npm start -- --resume ${session.id})`);
  console.log(`commands: /exit  /model <tag>  /mode <mode>  /models  /sessions  /new\n`);
  for (;;) {
    let input: string;
    try {
      input = (await rl.question("\n> ")).trim();
    } catch {
      // readline closed (Ctrl+C / Ctrl+D / EOF) — exit cleanly instead of crashing.
      console.log("\n(input closed — exiting)");
      break;
    }
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/models") {
      console.log(`configured: ${Object.keys(getModels()).join(", ")}`);
      try {
        const installed = await client.listModels();
        console.log(`installed in Ollama: ${installed.length ? installed.join(", ") : "(none)"}`);
      } catch (e) {
        console.log(`(couldn't query Ollama: ${(e as Error).message})`);
      }
      continue;
    }
    if (input === "/sessions") {
      for (const s of listSessions()) console.log(`${s.id}  ${s.createdAt}  (${s.messages} msgs)  ${s.firstUser}`);
      continue;
    }
    if (input === "/new") {
      session = Session.create({ model: activeModel, cwd: ctx.cwd });
      history = [];
      console.log(`started new session ${session.id}`);
      continue;
    }
    if (input.startsWith("/model ")) {
      const tag = input.slice("/model ".length).trim();
      if (getModels()[tag]) {
        activeModel = tag;
        console.log(`switched model -> ${tag}`);
      } else {
        console.log(`unknown model "${tag}". Known: ${Object.keys(getModels()).join(", ")}`);
      }
      continue;
    }
    if (input.startsWith("/mode ")) {
      const m = input.slice("/mode ".length).trim() as PermissionMode;
      permissions.setMode(m);
      console.log(`mode -> ${permissions.mode}`);
      continue;
    }
    if (input.startsWith("/")) {
      console.log(`unknown command "${input.split(" ")[0]}". commands: /exit  /model <tag>  /mode <mode>  /models  /sessions  /new`);
      continue;
    }
    try {
      await runTask(input);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
