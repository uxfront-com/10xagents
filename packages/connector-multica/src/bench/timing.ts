// Where the squad's time and money go, from Multica's own run records: how long each seat's runs
// wait for a slot and run, what starts them, what they cost, why they fail, and how long a review
// cycle takes from a delivery to its verdict. Under the squad protocol, a keyword at the head of a
// comment started each run, and under a workflow, a move into a step does, so a run gets the step
// its issue was at. Ported from uxfront's `.multica/squad-timing.mjs`.

import type { BenchQuery, MetricResult } from "10xagents";

import type { BenchSource, Issue, TimelineEntry } from "./read.ts";
import {
  BUILT_IN_STEPS,
  by,
  collector,
  finite,
  heading,
  ms,
  pct,
  pricer,
  runCost,
  sum,
} from "./shared.ts";

export const TIMING_METRICS = [
  "runs",
  "failed-runs",
  "queue-wait-p50",
  "queue-wait-p90",
  "run-time-p50",
  "run-time-p90",
  "queue-hours",
  "run-hours",
  "run-cost-p50",
  "run-cost",
  "failure-causes",
  "peak-concurrent-runs",
  "review-cycles",
  "review-cycles-with-wakeup",
  "review-cycle-p50",
  "review-cycle-p90",
  "review-cycle-share",
];

/** One run's timings, kind, status, failure reason and tokens. No comment text. */
export interface RunRow {
  run: string;
  segment: string | null;
  issue: string;
  issueId: string;
  parent: string | null;
  agent: string;
  leader: boolean;
  priority: string | number | null;
  status: string;
  failureReason: string | null;
  kind: string;
  attempt: number | undefined;
  created: string | undefined;
  started: string | null | undefined;
  completed: string | null | undefined;
  queueMin: number;
  runMin: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  models: string[];
  cost: number | null;
}

/** One review cycle on a work issue, from a delivery to its verdict. */
export interface CycleRow {
  issue: string;
  segment: string;
  kind: string;
  wakeups: number;
  total: number;
  queue: number;
  work: number;
  ciGap: number;
  cost: number | null;
}

// What started the run, from the first line of the triggering comment, or the wakeup's summary.
const KINDS: [RegExp, string][] = [
  [/^FIX\s+[—-]\s+mechanical/, "FIX — mechanical"],
  [/^FIX\s+[—-]\s+conflict/, "FIX — conflict"],
  [/^FIX\s+[—-]\s+owner/, "FIX — owner"],
  [/^FIX\s+[—-]\s+PLAN/, "FIX — PLAN"],
  [/^FIX\b/, "FIX"],
  [/^DELIVERY\b/, "DELIVERY"],
  [/^RESTACK\b/, "RESTACK"],
  [/^VERDICT:\s*FAIL/, "VERDICT FAIL"],
  [/^VERDICT:\s*CONFLICT/, "VERDICT CONFLICT"],
  [/^VERDICT:\s*PLAN WRONG/, "PLAN WRONG"],
  [/^VERDICT/, "VERDICT (other)"],
  [/^PLAN v\d+.*in review/, "PLAN in review"],
  [/^PLAN v\d+.*approved/, "PLAN approved"],
  [/^PLAN REVIEW/, "PLAN REVIEW"],
  [/^PLAN INFEASIBLE/, "PLAN INFEASIBLE"],
  [/^REPLAN/, "REPLAN"],
  [/^SYNTHESIS\b/, "SYNTHESIS"],
  [/^STAGE REVIEW\b/, "STAGE REVIEW"],
  [/^FINISHED/, "FINISHED"],
  [/^QUESTIONS/, "QUESTIONS"],
  [/^BLOCKED/, "BLOCKED"],
  [/^ESCALATE/, "ESCALATE"],
  [/^Delegated task/i, "failure notice"],
];
const kindOf = (summary: string | null | undefined): string => {
  const s = heading(summary);
  // No comment started it: an assignment or a move, read from the timeline below.
  if (!s) return "assignment or status";
  if (/^Wakeup: sub-issues closed/i.test(s)) return "stage barrier";
  if (/^Wakeup:/i.test(s)) return "wakeup";
  return KINDS.find(([re]) => re.test(s))?.[1] ?? "comment";
};

// The handoffs that start a review cycle under the squad protocol. The last two asked QA to review
// an integration branch.
const HANDOFFS = new Set([
  "DELIVERY",
  "FIX",
  "FIX — mechanical",
  "FIX — conflict",
  "FIX — owner",
  "FIX — PLAN",
  "RESTACK",
  "SYNTHESIS",
  "STAGE REVIEW",
]);

const statusAt = (issue: Issue, changes: readonly TimelineEntry[], t: number) => {
  let status = changes[0]?.details?.from ?? issue.status;
  for (const c of changes) {
    if (ms(c.created_at) > t) break;
    status = c.details?.to ?? status;
  }
  return status;
};

/** Measures the runs created in the window, and the review cycles that start in it. */
export const measureTiming = async (
  source: BenchSource,
  query: BenchQuery,
): Promise<{ metrics: MetricResult[]; runs: RunRow[]; cycles: CycleRow[]; notes: string[] }> => {
  const { since, until, split } = query;
  const { costOf, unpriced } = pricer();
  const log = query.log ?? (() => {});
  const notes: string[] = [];
  const inWindow = (t: number) => t >= since && t < until;
  const recent = source.issues.filter(
    (i) =>
      ms(i.last_activity_at ?? i.updated_at ?? i.created_at) >= since && ms(i.created_at) < until,
  );
  log(
    `${source.issues.length} issues, ${recent.length} touched in the window; reading their runs…`,
  );

  const runs: RunRow[] = [];
  // Every run of each issue, in the window or not, so a review cycle that starts in the window can
  // run to its verdict.
  const histories: { issue: Issue; history: RunRow[] }[] = [];
  let unread = 0;
  const truncated: string[] = [];
  for (const issue of recent) {
    let list;
    try {
      list = source.runs(issue.id);
    } catch (error) {
      log(
        `  skipped ${issue.identifier ?? issue.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    // A workflow starts a step's run with the move into it, which leaves no summary, so the step
    // comes from the issue's status changes. Multica queues the run within the move's request, so
    // a second's grace covers it.
    let changes: TimelineEntry[] | null = null;
    if (list.some((r) => kindOf(r.trigger_summary) === "assignment or status")) {
      try {
        const { data, warnings } = await source.timeline(issue.id, true);
        // The server caps activities and comments apart, and names the kinds it cut, so a long
        // comment thread leaves the status changes whole.
        const cut = /truncated by the server cap \(([^)]*)\)/i.exec(warnings);
        if (cut ? /activit/i.test(cut[1] ?? "") : /truncated/i.test(warnings)) {
          truncated.push(issue.identifier ?? issue.id);
        }
        changes = data.toSorted((a, b) => ms(a.created_at) - ms(b.created_at));
      } catch (error) {
        unread++;
        log(
          `  no steps for ${issue.identifier ?? issue.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const history: RunRow[] = [];
    for (const r of list) {
      const kind = kindOf(r.trigger_summary);
      const usage = (r.usage ?? []).reduce(
        (total, u) => ({
          input: total.input + (u.input_tokens ?? 0),
          output: total.output + (u.output_tokens ?? 0),
          cacheRead: total.cacheRead + (u.cache_read_tokens ?? 0),
          cacheWrite: total.cacheWrite + (u.cache_write_tokens ?? 0),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      );
      const created = ms(r.created_at);
      const record: RunRow = {
        run: r.id,
        segment: inWindow(created) ? (split.segmentOf(created) ?? null) : null,
        issue: issue.identifier ?? issue.id,
        issueId: issue.id,
        parent: issue.parent_issue_id ?? null,
        agent: source.agentNames.get(r.agent_id) ?? r.agent_id,
        leader: Boolean(r.is_leader_task),
        priority: r.priority ?? null,
        status: r.status,
        failureReason: r.status === "failed" ? r.failure_reason || "unknown" : null,
        kind:
          kind === "assignment or status" && changes
            ? `at ${statusAt(issue, changes, created + 1000) ?? ""}`
            : kind,
        attempt: r.attempt,
        created: r.created_at,
        started: r.started_at,
        completed: r.completed_at,
        queueMin: (ms(r.started_at) - created) / 60000,
        runMin: (ms(r.completed_at) - ms(r.started_at)) / 60000,
        usage,
        models: [...new Set((r.usage ?? []).map((u) => u.model).filter((m): m is string => !!m))],
        cost: runCost(r.usage, ms(r.started_at) > 0, costOf),
      };
      history.push(record);
      if (inWindow(created)) runs.push(record);
    }
    histories.push({ issue, history });
  }

  // A review cycle on one work issue: the reviewer's runs from a delivery to its verdict, CI
  // wakeups included. A DELIVERY, FIX, RESTACK, SYNTHESIS or STAGE REVIEW comment starts one under
  // the squad protocol, and a move or an assignment at a review step under a workflow.
  const reviewer = runs.find((r) => /^QA$/i.test(r.agent))?.agent ?? "QA";
  const reviewKinds = new Set(query.reviewSteps.map((step) => `at ${step}`));
  const cycles: {
    issue: string;
    kind: string;
    runs: RunRow[];
    pending?: boolean;
    start: number;
  }[] = [];
  for (const { issue, history } of histories) {
    const ordered = history
      .filter((r) => r.created)
      .toSorted((a, b) => ms(a.created) - ms(b.created));
    let current: (typeof cycles)[number] | null = null;
    for (const r of ordered) {
      if (r.agent !== reviewer) {
        // Another seat's run on a move means the issue left the review. One a comment started
        // leaves the cycle open for QA's wakeup.
        if (r.kind.startsWith("at ")) current = null;
        continue;
      }
      // Multica retries a failed run as a new one with the same trigger and the next attempt
      // number, so a retry continues its cycle.
      if (current && (r.kind === "wakeup" || (r.attempt ?? 0) > 1)) {
        current.runs.push(r);
      } else if (HANDOFFS.has(r.kind) || reviewKinds.has(r.kind)) {
        current = {
          issue: issue.identifier ?? issue.id,
          kind: r.kind,
          runs: [r],
          start: ms(r.created),
        };
        // A cycle counts when it starts in the window, and runs to its verdict.
        if (inWindow(current.start)) cycles.push(current);
      }
    }
    // One still open at a review step, with no other seat's move since, is waiting on CI.
    if (current && cycles.at(-1) === current && query.reviewSteps.includes(issue.status ?? "")) {
      current.pending = true;
    }
  }
  const cycleRows: CycleRow[] = [];
  for (const c of cycles) {
    const first = c.runs[0];
    const last = c.runs.at(-1);
    const segment = split.segmentOf(c.start);
    // A cycle counts once its last run finished; a cancelled one never reached a verdict.
    if (!first || !last || segment === undefined || c.pending) continue;
    if (last.status !== "completed" || !c.runs.every((r) => r.completed)) continue;
    const total = (ms(last.completed) - ms(first.created)) / 60000;
    const queue = sum(c.runs.map((r) => Math.max(0, r.queueMin || 0)));
    const work = sum(c.runs.map((r) => Math.max(0, r.runMin || 0)));
    const costs = c.runs.map((r) => r.cost);
    cycleRows.push({
      issue: c.issue,
      segment,
      kind: c.kind,
      wakeups: c.runs.filter((r) => r.kind === "wakeup").length,
      total,
      queue,
      work,
      ciGap: Math.max(0, total - queue - work),
      // Unknown when a run in it ran without reporting usage, rather than free.
      cost: costs.includes(null) ? null : sum(costs.map((x) => x ?? 0)),
    });
  }

  const metrics: MetricResult[] = [];
  for (const segment of split.segments) {
    const { results, add } = collector(segment);
    const inSegment = runs.filter((r) => r.segment === segment);
    const summarise = (group: RunRow[], slice: Record<string, string>) => {
      const queue = finite(group.map((r) => r.queueMin));
      const run = finite(group.map((r) => r.runMin));
      // A run that never started cost nothing, but it isn't a run's cost either.
      const cost = finite(
        group.filter((r) => ms(r.started) > 0 || r.cost !== 0).map((r) => r.cost),
      );
      add("runs", group.length, slice);
      add("failed-runs", group.filter((r) => r.status === "failed").length, slice);
      add("queue-wait-p50", pct(queue, 0.5), slice);
      add("queue-wait-p90", pct(queue, 0.9), slice);
      add("run-time-p50", pct(run, 0.5), slice);
      add("run-time-p90", pct(run, 0.9), slice);
      add("queue-hours", sum(queue) / 60, slice);
      add("run-hours", sum(run) / 60, slice);
      add("run-cost-p50", pct(cost, 0.5), slice);
      add("run-cost", cost.length ? sum(cost) : Number.NaN, slice);
    };
    add("runs", inSegment.length);
    for (const [seat, group] of by(inSegment, (r) => r.agent)) summarise(group, { seat });
    for (const [, group] of by(inSegment, (r) => `${r.agent} · ${r.kind}`)) {
      const first = group[0];
      if (first) summarise(group, { seat: first.agent, kind: first.kind });
    }
    // Multica retries runtime, network and timeout failures on its own, so the reasons say whether
    // a failure was the machine's or the run's.
    const failures = inSegment.filter((r) => r.failureReason);
    for (const [, group] of by(failures, (r) => `${r.agent}\u0000${r.failureReason ?? ""}`)) {
      const first = group[0];
      if (first) {
        add("failure-causes", group.length, {
          seat: first.agent,
          reason: first.failureReason ?? "",
        });
      }
    }
    // How busy each seat's slots were: the most runs of one agent running at once.
    for (const [seat, group] of by(inSegment, (r) => r.agent)) {
      const events = group
        .filter((r) => r.started && r.completed)
        .flatMap((r): [number, number][] => [
          [ms(r.started), 1],
          [ms(r.completed), -1],
        ])
        .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
      let now = 0;
      let peak = 0;
      for (const [, d] of events) peak = Math.max(peak, (now += d));
      add("peak-concurrent-runs", peak, { seat });
    }
    const segmentCycles = cycleRows.filter((c) => c.segment === segment);
    add("review-cycles", segmentCycles.length);
    add("review-cycles-with-wakeup", segmentCycles.filter((c) => c.wakeups > 0).length);
    const totalTime = Math.max(1, sum(segmentCycles.map((c) => c.total)));
    for (const [part, key] of [
      ["total", "total"],
      ["queue", "queue"],
      ["work", "work"],
      ["ci-gap", "ciGap"],
    ] as const) {
      const xs = finite(segmentCycles.map((c) => c[key]));
      add("review-cycle-p50", pct(xs, 0.5), { part });
      add("review-cycle-p90", pct(xs, 0.9), { part });
      add("review-cycle-share", segmentCycles.length ? sum(xs) / totalTime : Number.NaN, { part });
    }
    metrics.push(...results);
  }

  // A review step key that isn't the default finds no cycles. QA also runs at built-in steps, and
  // at the plan step, so only another of the workflow's own steps says the key is off.
  const strange = [
    ...new Set(
      runs
        .filter((r) => r.agent === reviewer && r.kind.startsWith("at "))
        .map((r) => r.kind.slice(3))
        .filter(
          (step) =>
            !BUILT_IN_STEPS.has(step) &&
            !query.reviewSteps.includes(step) &&
            !query.planSteps.includes(step),
        ),
    ),
  ];
  if (strange.length) {
    notes.push(
      `${reviewer} ran at ${strange.join(", ")}, which is neither a --review-step (${query.reviewSteps.join(", ")}) nor a --plan-step (${query.planSteps.join(", ")}): if one is your review or plan step, pass its key.`,
    );
  }
  if (unread) notes.push(`${unread} issues had an unreadable timeline.`);
  if (truncated.length) {
    notes.push(
      `The server cut these timelines short, so early steps may be off: ${truncated.join(", ")}.`,
    );
  }
  if (unpriced.size) notes.push(`Priced as Opus 5.5: ${[...unpriced].join(", ")}.`);
  return { metrics, runs, cycles: cycleRows, notes };
};
