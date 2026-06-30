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

const RETRYABLE_NET_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "ECONNABORTED",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

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
  // A6: a concrete network/system code is AUTHORITATIVE — retry only known-transient codes. TLS/cert codes
  // (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ERR_TLS_*) aren't in the set
  // → fail fast. The fuzzy message regex is a fallback used ONLY when no code surfaced (a bare "fetch failed").
  if (code) return RETRYABLE_NET_CODES.has(code);
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
  // NIT: a negative/NaN maxRetries must still attempt ONCE (else the loop never runs and we throw `undefined`).
  const maxRetries = Number.isFinite(cfg.maxRetries) ? Math.max(0, Math.trunc(cfg.maxRetries)) : 0;
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err; // user cancelled mid-attempt
      if (i === maxRetries || !shouldRetry(err)) throw err;
      await sleepWithAbort(backoffDelayMs(i, cfg), signal);
    }
  }
  throw lastErr;
}

/**
 * A7: idle/stall watchdog for streaming. Aborts after `idleMs` of inactivity UNLESS `kick()` is called — call it on
 * each received chunk so a healthy long stream is never killed (it's a stall guard, not a total deadline). `clear()`
 * stops it (call in finally). A user abort is forwarded immediately. idleMs<=0 → pass the user signal straight
 * through (no timeout). Fires a TimeoutError, which `shouldRetry` treats as retryable.
 */
export function idleWatchdog(
  idleMs: number,
  userSignal?: AbortSignal,
): { signal: AbortSignal | undefined; kick: () => void; clear: () => void } {
  if (!idleMs || idleMs <= 0) return { signal: userSignal, kick: () => {}, clear: () => {} };
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    userSignal?.removeEventListener("abort", onUserAbort);
  };
  function onUserAbort(): void {
    clear();
    ctl.abort(userSignal?.reason ?? new Error("aborted"));
  }
  const arm = (): void => {
    timer = setTimeout(
      () => ctl.abort(Object.assign(new Error(`stream idle ${idleMs}ms`), { name: "TimeoutError" })),
      idleMs,
    );
  };
  if (userSignal?.aborted) {
    ctl.abort(userSignal.reason);
    return { signal: ctl.signal, kick: () => {}, clear: () => {} };
  }
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  arm();
  return { signal: ctl.signal, kick: () => { clear(); arm(); }, clear };
}
