// list_models tool — lets the agent see which models are installed in the local Ollama.
//
// Read-only: it only queries Ollama's /api/tags (no workspace side effects), so the
// permission gate auto-allows it. Closes the gap where "which models do I have?" had no
// matching tool and a weak model would mis-fire (e.g. call recall).

import type { OllamaClient } from "./ollamaClient.ts";
import type { Tool } from "../tools/tools.ts";

export function makeListModelsTool(client: OllamaClient): Tool {
  return {
    name: "list_models",
    description:
      "List the model tags currently installed in the local Ollama server (the models you can run). Use this to answer questions like 'which models do I have?' or 'how many models are installed?'.",
    readOnly: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    async execute() {
      try {
        const models = await client.listModels();
        return models.length > 0
          ? `Installed Ollama models (${models.length}):\n${models.map((m) => `- ${m}`).join("\n")}`
          : "No models are installed in Ollama.";
      } catch (e) {
        return `Error listing Ollama models: ${(e as Error).message}`;
      }
    },
  };
}
