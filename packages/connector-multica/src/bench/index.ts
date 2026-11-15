// The Multica connector's `bench`: requests, run timing and review verdicts, read from one
// workspace through the `multica` CLI.

import type { BenchQuery, BenchResult } from "10xagents";

import type { BenchSource, ReadContext } from "./read.ts";
import { openSource } from "./read.ts";
import { measureRequests, REQUEST_METRICS } from "./requests.ts";
import { measureTiming, TIMING_METRICS } from "./timing.ts";
import { measureVerdicts, VERDICT_METRICS } from "./verdicts.ts";

export { REQUEST_METRICS, TIMING_METRICS, VERDICT_METRICS };
export type { BenchSource } from "./read.ts";
export type { RequestRow } from "./requests.ts";
export type { CycleRow, RunRow } from "./timing.ts";
export type { VerdictRow } from "./verdicts.ts";

/** Every metric the Multica connector reports. */
export const MULTICA_METRICS: string[] = [
  ...REQUEST_METRICS,
  ...TIMING_METRICS,
  ...VERDICT_METRICS,
];

/** Measures everything from `source`. Tests hand it a source of fixtures. */
export const benchFrom = async (source: BenchSource, query: BenchQuery): Promise<BenchResult> => {
  const log = query.log ?? (() => {});
  log(`Workspace ${source.workspace.name}`);
  const requests = await measureRequests(source, query);
  const timing = await measureTiming(source, query);
  const verdicts = measureVerdicts(source, query);
  return {
    metrics: [...requests.metrics, ...timing.metrics, ...verdicts.metrics],
    rows: {
      requests: requests.rows,
      runs: timing.runs,
      cycles: timing.cycles,
      verdicts: verdicts.rows,
    },
    notes: [...source.notes, ...requests.notes, ...timing.notes, ...verdicts.notes],
  };
};

/** Measures the target's workspace on Multica. */
export const bench = async (query: BenchQuery, context: ReadContext): Promise<BenchResult> => {
  const source = await openSource(query, context);
  try {
    return await benchFrom(source, query);
  } finally {
    source.close();
  }
};
