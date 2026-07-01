// usage — a PURE session token/cost tally (SRP: accounting only; no I/O). Per turn we add the real prompt/eval token
// counts the model reports; `/cost` and the on-exit summary render it. Cost is a LOCAL ESTIMATE (tokens × a per-model
// price table); for local models there is no API price, so it shows as free. Never billed — labeled an estimate.

export interface Tally {
  input: number; // prompt tokens processed (grows with context each turn — real compute)
  output: number; // generated tokens
  turns: number;
}

export interface Price {
  inPerM: number; // USD per 1M input tokens
  outPerM: number; // USD per 1M output tokens
}

export function emptyTally(): Tally {
  return { input: 0, output: 0, turns: 0 };
}

export function addTurn(t: Tally, input: number, output: number): Tally {
  return { input: t.input + Math.max(0, input), output: t.output + Math.max(0, output), turns: t.turns + 1 };
}

export function estimateCost(t: Tally, price?: Price): number {
  if (!price) return 0;
  return (t.input / 1e6) * price.inPerM + (t.output / 1e6) * price.outPerM;
}

function group(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** One-line usage summary. `price` (optional) turns the token counts into a labeled USD estimate. */
export function formatUsage(t: Tally, opts: { price?: Price } = {}): string {
  const money = opts.price ? `~$${estimateCost(t, opts.price).toFixed(4)} (estimate)` : "$0.00 (local model — free)";
  return `${t.turns} turn(s) · ${group(t.input)} in / ${group(t.output)} out tokens · ${money}`;
}
