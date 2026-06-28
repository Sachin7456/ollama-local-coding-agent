// Preflight — a one-time startup check so the harness fails with helpful guidance
// instead of a cryptic crash when a prerequisite is missing.
//
// It runs ONCE at startup (see main.ts). It is not called during the agent loop,
// so it adds no per-turn latency.
//
// Checks: Node version (for native type-stripping), Ollama reachable, and that the
// required model(s) are pulled. Each failure includes the simplest fix.

import os from "node:os";

/**
 * Best-effort RAM headroom check for multi-model (multi-agent) runs. Sums the chosen models' `approxSizeGB`
 * (+ ~20% for KV cache / framework overhead) and compares to total system RAM; returns a WARNING string if it
 * likely won't fit, else null. Honest + zero-dep: it only WARNS (we can't reliably read GPU VRAM cross-platform
 * without a dependency, and setting OLLAMA_* env vars from this client has no effect on an already-running
 * Ollama server — see ROADMAP M13 for real memory-aware enforcement). Pure (totalMemBytes injectable) → testable.
 */
export function checkMemoryHeadroom(
  requiredModels: string[],
  models: Record<string, { approxSizeGB?: number }>,
  totalMemBytes: number = os.totalmem(),
): string | null {
  let sumGB = 0;
  for (const tag of requiredModels) {
    const gb = models[tag]?.approxSizeGB;
    if (typeof gb === "number" && gb > 0) sumGB += gb;
  }
  if (sumGB <= 0) return null; // unknown sizes — don't guess
  const neededGB = sumGB * 1.2;
  const haveGB = totalMemBytes / 1e9;
  if (neededGB <= haveGB) return null;
  return (
    `the selected models need ~${neededGB.toFixed(1)} GB but this machine has ~${haveGB.toFixed(1)} GB RAM — ` +
    `loading them together may exhaust memory and kill the run. Use a smaller model, single-agent mode, or fewer models.`
  );
}

export interface PreflightInput {
  baseUrl: string;
  /** models that MUST be installed (active + worker) — missing = fatal. */
  requiredModels: string[];
  /** models declared (e.g. in a models file) but not necessarily used now — missing = warning. */
  optionalModels?: string[];
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  /** non-fatal notices (e.g. a declared-but-not-pulled model). */
  warnings: string[];
}

/** Minimum Node that supports `--experimental-strip-types` + `node:test`. */
const MIN_NODE = [22, 6];

function nodeVersionProblem(versionString: string): string | null {
  const m = versionString.match(/^v?(\d+)\.(\d+)/);
  if (!m) return null; // unknown format — don't block
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  if (ok) return null;
  return (
    `Node.js ${MIN_NODE[0]}.${MIN_NODE[1]}+ is required (you have ${versionString}).\n` +
    `  • Upgrade Node from https://nodejs.org (LTS or current).`
  );
}

/**
 * Run the checks. `fetchImpl` is injectable so this is unit-testable without a real
 * server. Uses a short timeout so a down server doesn't hang startup.
 */
export async function preflight(
  input: PreflightInput,
  fetchImpl: typeof fetch = fetch,
  nodeVersion: string = process.version,
): Promise<PreflightResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const nodeProblem = nodeVersionProblem(nodeVersion);
  if (nodeProblem) problems.push(nodeProblem);

  let reachable = false;
  let installed: string[] = [];
  try {
    const res = await fetchImpl(`${input.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      reachable = true;
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      installed = Array.isArray(json.models) ? json.models.map((m) => m.name ?? "").filter(Boolean) : [];
    }
  } catch {
    /* not reachable */
  }

  if (!reachable) {
    problems.push(
      `Ollama is not reachable at ${input.baseUrl}.\n` +
        `  • Install Ollama:  https://ollama.com/download\n` +
        `  • Then start it:   ollama serve`,
    );
  } else {
    for (const m of input.requiredModels) {
      if (!installed.includes(m)) {
        problems.push(`Required model "${m}" is not installed.\n  • Get it with:  ollama pull ${m}`);
      }
    }
    for (const m of input.optionalModels ?? []) {
      if (!installed.includes(m) && !input.requiredModels.includes(m)) {
        warnings.push(`Model "${m}" is listed in your models file but not installed yet (run: ollama pull ${m}).`);
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

/** Pretty-print preflight problems for the CLI. */
export function formatPreflight(result: PreflightResult): string {
  if (result.ok) return "";
  return (
    "\n⛔ qwen-harness can't start — please fix the following:\n\n" +
    result.problems.map((p) => `• ${p}`).join("\n\n") +
    "\n"
  );
}
