// Transient-failure retry: exponential backoff + jitter (zero-dep). Shared by every provider client
// (the Ollama client, the /v1-compatible client, ...) so the resilience logic lives in ONE place.

/** Retry/backoff tuning. Defaults match common SDK practice, tightened for a fast LOCAL server. */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** ± fraction applied to each delay to avoid synchronized retries (thundering herd). */
  jitterRatio: number;
}

export const RETRY_DEFAULTS: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 4000,
  factor: 2,
  jitterRatio: 0.25,
};

const RETRYABLE_NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

/** Pull a network error code off an error OR its `.cause` — Node's `fetch` wraps the real cause in a TypeError. */
function networkCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e?.code === "string") return e.code;
  const cause = e?.cause;
  if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") {
    return (cause as { code: string }).code;
  }
  return undefined;
}

/**
 * Whether a failed request should be retried — TRANSIENT failures ONLY:
 *  • HTTP 408 / 429 / 5xx (status attached on the thrown error),
 *  • network errors (ECONNREFUSED etc. — `fetch` surfaces these as a TypeError with the code under `.cause`),
 *  • a per-request `TimeoutError` (the server stalled).
 * NEVER retries a user `AbortError` (Ctrl+C), other 4xx, or anything unrecognized (conservative default).
 */
export function shouldRetry(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown; message?: unknown };
  if (e?.name === "AbortError") return false; // user cancelled
  if (e?.name === "TimeoutError") return true; // per-request timeout
  if (typeof e?.status === "number") return e.status === 408 || e.status === 429 || e.status >= 500;
  const code = networkCode(err);
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  return /fetch failed|network|timed? ?out/i.test(String(e?.message ?? ""));
}

/** Exponential backoff with ± jitter for attempt `i` (0-based). Pure. */
export function backoffDelayMs(i: number, cfg: RetryConfig = RETRY_DEFAULTS): number {
  const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * Math.pow(cfg.factor, i));
  const jitter = base * cfg.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Sleep that settles early (rejecting) if the signal aborts — so Ctrl+C cancels a pending backoff at once. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt`, retrying TRANSIENT failures with exponential backoff + jitter. The USER `signal` (not any
 * per-request timeout) stops the loop: an abort throws immediately — at the top of an iteration AND right after a
 * caught error, before any backoff (so a Ctrl+C during the error window can't trigger another attempt).
 */
export async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal | undefined,
  cfg: RetryConfig = RETRY_DEFAULTS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= cfg.maxRetries; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err; // user cancelled mid-attempt
      if (i === cfg.maxRetries || !shouldRetry(err)) throw err;
      await sleepWithAbort(backoffDelayMs(i, cfg), signal);
    }
  }
  throw lastErr;
}
