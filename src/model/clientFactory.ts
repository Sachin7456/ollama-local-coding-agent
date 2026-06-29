// Resolve the right ModelClient for a model tag, based on its connection/routing. Memoized per
// type+baseUrl+apiKeyEnv so every model on one endpoint shares a client AND two compat models on the same endpoint
// with different API keys get separate clients. The agent loop calls clientFor(activeModel) each task, so a
// `/model` switch — including cloud <-> local — transparently picks the matching client behind the SAME interface,
// and the provider-neutral history carries over unchanged.

import { OllamaClient } from "./ollamaClient.ts";
import { CompatClient } from "./compatClient.ts";
import type { ModelClient } from "./modelClient.ts";
import { resolveRouting } from "./config.ts";

const cache = new Map<string, ModelClient>();

/** The memoized ModelClient for a model tag, routed via its connection (inline override > connection > local). */
export function clientFor(tag: string): ModelClient {
  const { type, baseUrl, apiKeyEnv } = resolveRouting(tag);
  const key = `${type}|${baseUrl}|${apiKeyEnv ?? ""}`;
  let client = cache.get(key);
  if (!client) {
    client = type === "compat" ? new CompatClient(baseUrl, apiKeyEnv) : new OllamaClient(baseUrl);
    cache.set(key, client);
  }
  return client;
}

/** Clear the memoized clients (tests / a future config reload). */
export function resetClientCache(): void {
  cache.clear();
}
