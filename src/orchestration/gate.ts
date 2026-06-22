// Concurrency gate — a small async semaphore.
//
// A zero-dep async semaphore that caps how many LLM generations run at once.
// The cap is GENERATION-scoped —
// acquire only around client.chat(), never around tool execution or while a
// parent awaits its children — otherwise an orchestrator holding a permit while
// waiting for its subagents would deadlock.

export class Semaphore {
  private readonly max: number;
  private active = 0;
  private peak = 0;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  /** Acquire a permit; returns a release function that MUST be called once. */
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.take();
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.take();
    return this.makeRelease();
  }

  /** Run fn while holding exactly one permit. The safe API — always releases the permit. */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get activeCount(): number {
    return this.active;
  }
  /** Highest concurrent count observed — handy for tests/metrics. */
  get peakCount(): number {
    return this.peak;
  }
  get capacity(): number {
    return this.max;
  }

  private take(): void {
    this.active++;
    if (this.active > this.peak) this.peak = this.active;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — double release is a no-op
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
