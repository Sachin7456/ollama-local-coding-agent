// Live smoke test — talks to the REAL Ollama model (one tiny task).
// Run with:  npm run smoke        (default model)
//            HARNESS_MODEL=qwen3-coder:30b npm run smoke   (switch model)
//
// It creates a throwaway temp workspace with a sample file, then asks the model to
// use the read_file tool to find a secret word — exercising the full
// client + tools + permissions + agent loop against the real model. Touches nothing outside its temp dir.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OllamaClient } from "../src/model/ollamaClient.ts";
import { createDefaultRegistry } from "../src/tools/tools.ts";
import { createDefaultPermissions } from "../src/permissions/permissions.ts";
import { runAgent } from "../src/agent/agent.ts";
import { resolveModel } from "../src/model/config.ts";

async function main(): Promise<void> {
  const model = resolveModel();
  console.log("\n=== qwen-harness smoke test ===");
  console.log(`Model: ${model.name}  (num_ctx=${model.numCtx})\n`);

  const client = new OllamaClient();

  // Sanity: Ollama reachable + model present?
  try {
    const models = await client.listModels();
    if (!models.includes(model.name)) {
      console.error(`Model "${model.name}" not found. Available: ${models.join(", ") || "(none)"}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Cannot reach Ollama. Is 'ollama serve' running? ${(e as Error).message}`);
    process.exit(1);
  }

  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "qh-smoke-"));
  await fs.writeFile(path.join(ws, "sample.txt"), "The secret word is BANANA.\nThis is line two.\n");

  const res = await runAgent({
    client,
    registry: createDefaultRegistry(), // read_file + grep (read-only)
    permissions: createDefaultPermissions("default"),
    ctx: { cwd: ws },
    model: model.name,
    systemPrompt:
      "You are a coding assistant with tools. To answer questions about files you MUST call the read_file tool — never guess. After reading, reply in ONE short sentence.",
    userMessage: "Read the file sample.txt and tell me the secret word.",
    maxTurns: 6,
    onEvent: (e) => {
      if (e.type === "assistant") {
        if (e.toolCalls.length > 0) {
          const calls = e.toolCalls
            .map((c) => `${c.function.name}(${JSON.stringify(c.function.arguments)})`)
            .join(", ");
          console.log(`[turn ${e.turn}] model -> tool: ${calls}`);
        } else if (e.text.trim()) {
          console.log(`[turn ${e.turn}] model -> "${e.text.trim()}"`);
        }
      } else if (e.type === "tool_result") {
        const oneLine = e.content.replace(/\s+/g, " ").slice(0, 80);
        console.log(`[turn ${e.turn}] tool ${e.tool} [${e.decision}] -> ${oneLine}`);
      } else if (e.type === "done") {
        console.log(`[done] ${e.reason} (${e.turns} turns)`);
      }
    },
  });

  console.log(`\n--- Final answer ---\n${res.text}\n`);
  console.log(`stopReason=${res.stopReason}, turns=${res.turns}`);

  const ok = /banana/i.test(res.text);
  if (ok) {
    console.log("\n✅ SMOKE PASS: the model used the tool and found the secret word.");
  } else {
    console.log(
      "\n⚠️  SMOKE INCONCLUSIVE: 'BANANA' not in the final answer. The 7B may need a stronger nudge.",
    );
  }
  await fs.rm(ws, { recursive: true, force: true });
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
