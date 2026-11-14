// The statistics `bench` and its collectors share.

/** The finite values at or above 0, sorted. */
export const finite = (xs: readonly (number | null | undefined)[]): number[] =>
  xs
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0)
    .toSorted((a, b) => a - b);

/** The finite values, sorted, negatives included. */
export const sorted = (xs: readonly (number | null | undefined)[]): number[] =>
  xs
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    .toSorted((a, b) => a - b);

/** Nearest rank: the smallest value with at least `p` of the sorted `xs` at or below it. */
export const pct = (xs: readonly number[], p: number): number =>
  xs.length ? (xs[Math.max(0, Math.ceil(p * xs.length) - 1)] ?? Number.NaN) : Number.NaN;

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** A finite number, or `null` for `n/a`. */
export const value = (x: number): number | null => (Number.isFinite(x) ? x : null);
