// What the Multica measures share: statistics, prices and how a run's trigger reads.

import type { MetricResult } from "10xagents";

import type { Usage } from "./read.ts";

/** Milliseconds since the epoch, or `NaN` without a date. */
export const ms = (value: string | null | undefined): number =>
  value ? Date.parse(value) : Number.NaN;

/** The finite values at or above 0, sorted. */
export const finite = (xs: readonly (number | null | undefined)[]): number[] =>
  xs
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0)
    .toSorted((a, b) => a - b);

/** Nearest rank: the smallest value with at least `p` of the sorted `xs` at or below it. */
export const pct = (xs: readonly number[], p: number): number =>
  xs.length ? (xs[Math.max(0, Math.ceil(p * xs.length) - 1)] ?? Number.NaN) : Number.NaN;

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]): number =>
  xs.length ? sum(xs) / xs.length : Number.NaN;

/** Groups `xs` by `key`, in the order keys first appear. */
export const by = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const x of xs) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
  return map;
};

/** Counts each value, most first. */
export const count = (xs: readonly string[]): [string, number][] => {
  const map = new Map<string, number>();
  for (const x of xs) map.set(x, (map.get(x) ?? 0) + 1);
  return [...map].toSorted((a, b) => b[1] - a[1]);
};

/** Collects metric results for one segment. */
export const collector = (segment: string) => {
  const results: MetricResult[] = [];
  const add = (id: string, x: number | null, slice?: Record<string, string>): void => {
    results.push({
      id,
      segment,
      value: x !== null && Number.isFinite(x) ? x : null,
      ...(slice ? { by: slice } : {}),
    });
  };
  return { results, add };
};

/**
 * Dollars per million tokens at Anthropic's list prices, as Multica's own table has them
 * (`server/internal/metrics/pricing.go`), with five-minute cache writes. A model it doesn't know is
 * priced as Opus 5.5.
 */
export const PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/** Prices usage, and remembers the models it had to price as Opus 5.5. */
export const pricer = () => {
  const unpriced = new Set<string>();
  const costOf = (entries: readonly Usage[]): number =>
    entries.reduce((total, u) => {
      const key = Object.keys(PRICES).find((k) => (u.model ?? "").includes(k));
      if (!key) unpriced.add(u.model || "unnamed");
      const p = PRICES[key ?? "claude-opus-5-5"] ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      const tokens =
        (u.input_tokens ?? 0) * p.input +
        (u.output_tokens ?? 0) * p.output +
        (u.cache_read_tokens ?? 0) * p.cacheRead +
        (u.cache_write_tokens ?? 0) * p.cacheWrite;
      return total + tokens / 1e6;
    }, 0);
  return { costOf, unpriced };
};

/** A comment's or summary's first words, without the heading marks and emoji before them. */
export const heading = (text: string | null | undefined): string =>
  (text ?? "").replace(/^[#\s]*/, "").replace(/^[^\p{L}]+/u, "");

/** The workflow's built-in steps, where QA also runs without the key being off. */
export const BUILT_IN_STEPS: ReadonlySet<string> = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);

/** A run's cost: unknown when it ran without reporting usage, and nothing when it never started. */
export const runCost = (
  usage: readonly Usage[] | null | undefined,
  started: boolean,
  costOf: (entries: readonly Usage[]) => number,
): number | null => (usage?.length ? costOf(usage) : started ? null : 0);
