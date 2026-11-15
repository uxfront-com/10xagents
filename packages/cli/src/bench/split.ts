// The window `bench` measures, and how it splits it: as one, at a cutover, or by setup hash.

import type { BenchSplit } from "../contract.ts";
import type { SyncLogEntry } from "./sync-log.ts";
import { hashAt } from "./sync-log.ts";

const DAY = 86_400_000;

/**
 * A moment from `--since`, `--until` or `--cutover`: a number of days before `now`, or a date and
 * time. A date and time without a zone is local time, and a date alone is local midnight, which
 * `Date.parse` would read as UTC. `NaN` when it's neither.
 */
export const parseMoment = (value: string, now: number): number =>
  /^\d+(\.\d+)?$/.test(value)
    ? now - Number(value) * DAY
    : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value);

/** Everything in one segment, `all`, judged at `until`. */
export const wholeSplit = (until: number): BenchSplit => ({
  segments: ["all"],
  segmentOf: () => "all",
  placeRequest: () => ({ segment: "all", horizon: until }),
});

/**
 * Split at `cutover`. Runs and sessions go to `before` or `after` by when they started. A request
 * that started before the cutover and was done or stopped by it goes to `before`, judged at the
 * cutover; one still open there goes to `across`, judged at `until`; and one that started after
 * it goes to `after`, judged at `until`.
 */
export const cutoverSplit = (cutover: number, until: number): BenchSplit => ({
  segments: ["before", "across", "after"],
  cutover,
  segmentOf: (time) => (time >= cutover ? "after" : "before"),
  placeRequest: (start, isOpenAt) => {
    if (start >= cutover) return { segment: "after", horizon: until };
    if (isOpenAt(cutover)) return { segment: "across", horizon: until };
    return { segment: "before", horizon: cutover };
  },
});

/**
 * One segment per setup hash in `hashes`. A run, session or request counts under the hash that was
 * live for `target` when it started, from `entries`, and is left out when another hash, or none,
 * was live then. The other targets' syncs in the same log don't count.
 */
export const compareSplit = (
  target: string,
  entries: readonly SyncLogEntry[],
  hashes: readonly string[],
  until: number,
): BenchSplit => {
  const own = entries.filter((entry) => entry.target === target);
  const segmentOf = (time: number): string | undefined => {
    const live = hashAt(own, time);
    return live !== undefined && hashes.includes(live) ? live : undefined;
  };
  return {
    segments: [...hashes],
    segmentOf,
    placeRequest: (start) => {
      const segment = segmentOf(start);
      return segment === undefined ? undefined : { segment, horizon: until };
    },
  };
};
