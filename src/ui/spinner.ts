// spinner — live "working…" indicator: a frame + verb + elapsed time (+ optional token count). The FORMATTING and
// the pause-aware elapsed timer are PURE/testable (Clock injected, DIP); the animation loop (setInterval + repaint)
// is thin I/O wired by the caller. Pause accounting lets elapsed exclude time spent waiting on a permission dialog.

import type { Clock, Screen } from "./io.ts";
import type { Theme } from "./theme.ts";
import { makeTheme } from "./theme.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export interface SpinnerLine {
  verb: string; // "thinking" | "responding" | "using tools" | ...
  elapsedMs: number;
  tokens?: number;
}

export function formatSpinner(tick: number, line: SpinnerLine, theme: Theme = makeTheme(false)): string {
  const toks = typeof line.tokens === "number" ? theme.dim(` · ${line.tokens} tok`) : "";
  return `${theme.accent(spinnerFrame(tick))} ${line.verb}${theme.dim(" " + formatElapsed(line.elapsedMs))}${toks}`;
}

/** Elapsed timer that can be paused (e.g. while a permission dialog is open) so "thinking time" excludes the wait. */
export class ElapsedTimer {
  private clock: Clock;
  private startedAt: number;
  private pausedTotal = 0;
  private pausedAt: number | null = null;

  constructor(clock: Clock) {
    this.clock = clock;
    this.startedAt = clock.now();
  }
  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.clock.now();
  }
  resume(): void {
    if (this.pausedAt !== null) {
      this.pausedTotal += this.clock.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }
  elapsed(): number {
    const now = this.clock.now();
    const pausedNow = this.pausedAt !== null ? now - this.pausedAt : 0;
    return now - this.startedAt - this.pausedTotal - pausedNow;
  }
}

/** Thin animation driver: repaints one spinner line on the current row until stop(). I/O — not unit-tested. */
export function runSpinner(screen: Screen, theme: Theme, verb: string, clock: Clock): () => void {
  const timer = new ElapsedTimer(clock);
  let tick = 0;
  const paint = (): void => {
    screen.clearBelow();
    screen.write(formatSpinner(tick, { verb, elapsedMs: timer.elapsed() }, theme));
  };
  paint();
  const id = setInterval(() => {
    tick++;
    paint();
  }, 100);
  return () => {
    clearInterval(id);
    screen.clearBelow(); // erase the spinner line so real output takes its place
  };
}
