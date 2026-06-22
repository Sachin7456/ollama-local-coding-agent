// Preflight — a one-time startup check so the harness fails with helpful guidance
// instead of a cryptic crash when a prerequisite is missing.
//
// It runs ONCE at startup (see main.ts). It is not called during the agent loop,
// so it adds no per-turn latency.
//
// Checks: Node version (for native type-stripping), Ollama reachable, and that the
// required model(s) are pulled. Each failure includes the simplest fix.

export interface PreflightInput {
  baseUrl: string;
  requiredModels: string[];
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
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
  }

  return { ok: problems.length === 0, problems };
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
