// The shared metric catalogue. Connectors and collectors declare which of these ids they report,
// and `bench` shows every other one as `n/a`.

/** The four groups the catalogue sorts metrics into. */
export type MetricGroup = "outcome" | "review" | "cost-time" | "context";

/**
 * What a metric's value counts: a number of things, a duration, US dollars at list prices, a share
 * from 0 to 1, or tokens.
 */
export type MetricUnit = "count" | "hours" | "minutes" | "usd" | "ratio" | "tokens";

export interface MetricDefinition {
  id: string;
  group: MetricGroup;
  unit: MetricUnit;
  /** What it measures, in one line. */
  description: string;
}

const define = (
  group: MetricGroup,
  unit: MetricUnit,
  entries: Record<string, string>,
): MetricDefinition[] =>
  Object.entries(entries).map(([id, description]) => ({ id, group, unit, description }));

/** Every metric `bench` knows, in the order it prints them. */
export const METRICS: readonly MetricDefinition[] = [
  ...define("outcome", "count", {
    "requests-touched": "Requests a person made that someone worked on in the window",
    requests: "Requests whose first run falls in the window",
    "requests-done": "Requests that are done: they and every sub-issue closed",
    "requests-stopped": "Requests cancelled, or sent back to Backlog after they ran",
    "requests-open": "Requests neither done nor stopped",
    "requests-left-out": "Requests touched in the window but not counted, by reason",
  }),
  ...define("outcome", "hours", {
    "lead-time-p50": "From a done request's first run to done, less the time it sat parked: median",
    "lead-time-p90": "From a done request's first run to done, less the time it sat parked: p90",
  }),
  ...define("outcome", "count", {
    "people-actions-p50":
      "People's comments, moves, assignments and merges on a done request: median",
    "people-actions-p90": "People's comments, moves, assignments and merges on a done request: p90",
  }),
  ...define("outcome", "hours", {
    "waiting-on-people-p50": "Time a done request waited on people: median",
    "waiting-on-people-p90": "Time a done request waited on people: p90",
  }),
  ...define("outcome", "ratio", {
    "waiting-on-people-share": "The waiting on people, as a share of the done requests' lead time",
  }),
  ...define("review", "count", {
    "review-rounds-mean": "Review rounds per done request, on average",
    "plan-reviews-mean": "Plan reviews per done request, on average",
    "first-verdicts": "Work issues whose first verdict falls in the window, by result",
    "first-fail-blockers": "Blocking findings on those first FAILs, by why they block",
    "blockers-per-first-fail": "Blocking findings per first FAIL, on average",
    "first-fails-only-mechanical": "First FAILs whose blockers are all mechanical",
    "blocker-outcomes": "How the blockers on first FAILs ended, by state",
    "fix-answers": "The builders' answers to findings in every FIX in the window, by answer",
    "issues-by-pass-round": "Work issues by the round of their first PASS",
  }),
  ...define("cost-time", "count", {
    "runs-per-request-p50": "Runs on a done request and its sub-issues: median",
    "runs-per-request-p90": "Runs on a done request and its sub-issues: p90",
  }),
  ...define("cost-time", "hours", {
    "agent-time-per-request-p50": "Running time of a done request's runs: median",
    "agent-time-per-request-p90": "Running time of a done request's runs: p90",
  }),
  ...define("cost-time", "usd", {
    "cost-per-request-p50": "Cost of a done request whose cost is known: median",
    "cost-per-request-p90": "Cost of a done request whose cost is known: p90",
  }),
  ...define("cost-time", "count", {
    "requests-cost-known": "Done requests whose cost is known",
  }),
  ...define("cost-time", "usd", {
    "requests-cost": "The known cost of every request counted",
  }),
  ...define("cost-time", "count", {
    "requests-failed-runs": "Failed runs on every request counted",
    runs: "Runs created in the window, by seat, and by seat and what started them",
    "failed-runs": "Failed runs, by seat, and by seat and what started them",
  }),
  ...define("cost-time", "minutes", {
    "queue-wait-p50": "Time a run waited for a slot: median",
    "queue-wait-p90": "Time a run waited for a slot: p90",
    "run-time-p50": "Time a run ran: median",
    "run-time-p90": "Time a run ran: p90",
  }),
  ...define("cost-time", "hours", {
    "queue-hours": "Time runs waited for a slot, in all",
    "run-hours": "Time runs ran, in all",
  }),
  ...define("cost-time", "usd", {
    "run-cost-p50": "Cost of a run that started, where it's known: median",
    "run-cost": "Known cost of the runs that started, in all",
  }),
  ...define("cost-time", "count", {
    "failure-causes": "Failed runs, by seat and reason",
    "peak-concurrent-runs": "The most runs of one seat running at once",
    "review-cycles": "Review cycles, from a delivery to its verdict, that start in the window",
    "review-cycles-with-wakeup": "Review cycles that needed a CI wakeup",
  }),
  ...define("cost-time", "minutes", {
    "review-cycle-p50": "A review cycle's time, by part: total, queue, work and CI gap: median",
    "review-cycle-p90": "A review cycle's time, by part: total, queue, work and CI gap: p90",
  }),
  ...define("cost-time", "ratio", {
    "review-cycle-share": "Each part of the review cycles' time, as a share of their total",
  }),
  ...define("context", "count", {
    sessions: "Agent sessions with a run that starts in the window",
    "session-runs": "Runs that start in the window, by seat",
    "calls-per-run-p50": "Model calls per run: median",
    "calls-per-run-p90": "Model calls per run: p90",
  }),
  ...define("context", "tokens", {
    "context-at-start-p50": "Context size at a run's first call: median",
    "context-at-start-p90": "Context size at a run's first call: p90",
    "context-peak": "The largest context of any call in a run",
  }),
  ...define("context", "count", {
    compactions: "Compactions in the runs, by seat",
  }),
  ...define("context", "ratio", {
    "cache-write-1h-share": "The share of cache writes with the one-hour lifetime",
  }),
  ...define("context", "usd", {
    "session-cost": "Cost of the runs, subagents included, from the transcripts",
  }),
  ...define("context", "ratio", {
    "subagent-cost-share": "The subagents' share of that cost",
  }),
  ...define("context", "count", {
    forks: "Subagents started as forks of the session",
    "agents-md-reads-per-run": "Reads of an AGENTS.md per run",
    "skill-loads-per-run": "Skill loads per run",
    "tool-output-calls": "Tool results that entered the context, by tool",
  }),
  ...define("context", "tokens", {
    "tool-output-tokens":
      "Tokens of tool output that entered the context, by tool (4 characters a token)",
    "tool-output-tokens-per-call": "Tokens of tool output per call, by tool",
    "tool-output-largest": "The largest tool output, by tool",
  }),
  ...define("context", "count", {
    "tool-output-images": "Images in tool output, by tool",
  }),
];

const byId = new Map(METRICS.map((metric) => [metric.id, metric]));

/** The catalogue's entry for `id`, or `undefined` for an id it doesn't know. */
export const metricDefinition = (id: string): MetricDefinition | undefined => byId.get(id);
