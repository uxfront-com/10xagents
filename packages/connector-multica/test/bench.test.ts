import { compareSplit, cutoverSplit, wholeSplit } from "10xagents";
import type { BenchQuery, BenchResult, BenchSplit, MetricResult } from "10xagents";
import { describe, expect, it } from "vitest";

import { createConnector } from "../src/index.ts";
import { fake, freshState } from "./helpers.ts";
import type { FakeState } from "./helpers.ts";

const T0 = Date.parse("2026-11-02T00:00:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A moment `hours` (and `ms`) after T0, as Multica writes it. */
const at = (hours: number, ms = 0) => new Date(T0 + hours * HOUR + ms).toISOString();

const SINCE = T0 - 24 * HOUR;
const UNTIL = T0 + 48 * HOUR;

const move = (hours: number, from: string, to: string, actor = "agent", ms = 0) => ({
  type: "activity",
  action: "status_changed",
  actor_type: actor,
  created_at: at(hours, ms),
  details: { from, to },
});
const comment = (hours: number, actor: string, content: string) => ({
  type: "comment",
  actor_type: actor,
  created_at: at(hours),
  content,
});
const run = (
  id: string,
  agent: string,
  created: number,
  options: {
    summary?: string;
    started?: number | null;
    completed?: number | null;
    status?: string;
    usage?: Record<string, unknown>[];
    attempt?: number;
    failure?: string;
    createdMs?: number;
  } = {},
) => ({
  id,
  agent_id: agent,
  status: options.status ?? "completed",
  attempt: options.attempt ?? 1,
  trigger_summary: options.summary ?? "",
  created_at: at(created, options.createdMs ?? 0),
  started_at: options.started === null ? null : at(options.started ?? created + 1 / 60),
  completed_at: options.completed === null ? null : at(options.completed ?? created + 1),
  failure_reason: options.failure ?? null,
  usage: options.usage ?? [],
});
const opus = (tokens: Record<string, number>) => [{ model: "claude-opus-5-5", ...tokens }];
const issue = (
  id: string,
  identifier: string,
  created: number,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  identifier,
  status,
  creator_type: "member",
  parent_issue_id: null,
  created_at: at(created),
  last_activity_at: at(created + 10),
  ...extra,
});

const report = (round: number, ledger: string, settled = "") =>
  `# Verdict r${round}\n\n## Blocking\n\n${ledger}\n\n## Settled\n\n${settled}\n\n## Nits\n\n- A nit.\n\n## Evidence\n\nsecret command output\n`;

/**
 * A workspace with three requests a person made, one an agent filed, and their runs, timelines and
 * comments:
 *
 * - UXF-1 runs from 0h to Done at 10h01: the Builder (0h–4h, $4), a QA run cancelled while queued,
 *   and QA's review (4h–6h, $2). The owner comments at 10h and moves it to Done a minute later. It
 *   has a FAIL, a FIX and a PASS.
 * - UXF-2 starts at 1h and stays open. A run without usage makes its cost unknown, and QA's review
 *   from a DELIVERY runs on through a CI wakeup.
 * - UXF-3 starts at 20h and stays open.
 * - UXF-4 is an agent's.
 */
const agent = (id: string, name: string) => ({
  id,
  name,
  description: "",
  model: "",
  thinking_level: "",
  max_concurrent_tasks: 1,
  instructions: "",
  skills: [],
});

const benchState = (): FakeState => {
  const state = freshState();
  state.agents = [agent("ag-qa", "QA"), agent("ag-b", "Builder")];
  state.issues = [
    issue("i1", "UXF-1", 0, "done"),
    issue("i2", "UXF-2", 1, "in_progress"),
    issue("i3", "UXF-3", 20, "todo"),
    issue("i4", "UXF-4", 2, "done", { creator_type: "agent" }),
  ];
  state.timelines = {
    i1: [
      move(0, "backlog", "in_progress", "member"),
      move(4, "in_progress", "quality_assurance"),
      move(6, "quality_assurance", "in_review"),
      comment(10, "member", "Looks good."),
      move(10, "in_review", "done", "member", MINUTE),
    ],
    i2: [move(1, "backlog", "in_progress", "member")],
    i3: [],
    i4: [move(2, "todo", "done")],
  };
  state.runs = {
    i1: [
      run("b1", "ag-b", 0, { started: 1 / 60, completed: 4, usage: opus({ input_tokens: 1e6 }) }),
      run("q0", "ag-qa", 4, {
        status: "cancelled",
        started: null,
        completed: null,
        createdMs: -500,
      }),
      run("q1", "ag-qa", 4, {
        started: 4 + 2 / 60,
        completed: 6,
        usage: opus({ output_tokens: 1e5 }),
      }),
    ],
    i2: [
      run("b2", "ag-b", 1, { completed: 3 }),
      run("q2", "ag-qa", 1.5, { summary: "## DELIVERY of the part", completed: 1.75 }),
      run("q3", "ag-qa", 1.8, {
        summary: "Wakeup: CI finished",
        completed: 2,
        usage: opus({ input_tokens: 250_000 }),
      }),
      run("f2", "ag-b", 3, { status: "failed", failure: "runtime_offline", completed: 3.5 }),
    ],
    i3: [run("b3", "ag-b", 20, { completed: 21, usage: opus({ input_tokens: 500_000 }) })],
    i4: [run("b4", "ag-b", 2, { completed: 2.5 })],
  };
  state.comments = {
    i1: [
      {
        author_id: "ag-qa",
        author_type: "agent",
        created_at: at(6),
        content:
          "## ❌ VERDICT: FAIL (round 1) — 1 blocking\n\n## Blocking\n\n1. B1 · `src/secret.ts:4` · the cache never clears\n",
        attachments: [{ id: "att-1", filename: "verdict-r1.md" }],
      },
      {
        author_id: "ag-b",
        author_type: "agent",
        created_at: at(7),
        content: "## FIX — mechanical\n\n1. B1 → fixed at `src/secret.ts:9`\n",
      },
      {
        author_id: "ag-qa",
        author_type: "agent",
        created_at: at(8),
        content: "## ✅ VERDICT: PASS (round 2)\n",
        attachments: [{ id: "att-2", filename: "verdict-r2.md" }],
      },
    ],
  };
  state.attachments = {
    "att-1": {
      filename: "verdict-r1.md",
      text: report(1, "1. B1 · `src/secret.ts:4` · raised r1 as `regression` · open"),
    },
    "att-2": {
      filename: "verdict-r2.md",
      text: report(2, "", "1. B1 · `src/secret.ts:4` · raised r1 as `regression` · fixed r2"),
    },
  };
  return state;
};

const query = (
  split: BenchSplit = wholeSplit(UNTIL),
  extra: Partial<BenchQuery> = {},
): BenchQuery => ({
  target: { id: "team", workspace: "team", connector: "multica" },
  since: SINCE,
  until: UNTIL,
  split,
  reviewSteps: ["quality_assurance"],
  planSteps: ["plan_review"],
  profile: "p1",
  ...extra,
});

const benchWith = async (state: FakeState, q: BenchQuery = query()) => {
  const multica = fake(state);
  const connector = createConnector({ env: multica.env, desktop: "/nowhere/multica" });
  if (!connector.bench) throw new Error("the Multica connector has no bench");
  const result: BenchResult = await connector.bench(q);
  return { result, multica };
};

/** A table of the result's rows, each as a record. */
const table = (result: BenchResult, name: string): Record<string, unknown>[] =>
  (result.rows?.[name] ?? []).filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );

const value = (
  metrics: readonly MetricResult[],
  id: string,
  by?: Record<string, string>,
  segment: string | undefined = "all",
) =>
  metrics.find(
    (metric) =>
      metric.id === id &&
      (metric.segment === undefined || metric.segment === segment) &&
      JSON.stringify(metric.by ?? null) === JSON.stringify(by ?? null),
  )?.value;

describe("bench: requests", () => {
  it("measures each request a person made, from its first run to Done", async () => {
    const { result } = await benchWith(benchState());
    const rows = table(result, "requests");
    expect(rows.map((row) => row.request)).toEqual(["UXF-1", "UXF-2", "UXF-3"]);
    expect(rows[0]).toEqual({
      request: "UXF-1",
      segment: "all",
      created: at(0),
      firstRun: at(0),
      outcome: "done",
      leadHours: 10 + 1 / 60,
      issues: 1,
      linkedIssues: [],
      runs: 3,
      failedRuns: 0,
      agentHours: 4 - 1 / 60 + 2 - 2 / 60,
      // The run cancelled while it was queued cost nothing.
      cost: 4 + 2,
      costKnown: 6,
      reviewRounds: 1,
      planReviews: 0,
      // The comment and the move a minute later are one action.
      peopleActions: 1,
      // From QA's last move at 6h to the owner's comment at 10h.
      waitedHours: 4,
    });
    // A run that ran without reporting usage makes the cost unknown, not free.
    expect(rows[1]).toMatchObject({
      outcome: "open",
      cost: null,
      costKnown: 0.25 * 4,
      reviewRounds: 1,
    });

    const { metrics } = result;
    expect(value(metrics, "requests")).toBe(3);
    expect(value(metrics, "requests-done")).toBe(1);
    expect(value(metrics, "requests-open")).toBe(2);
    expect(value(metrics, "lead-time-p50")).toBeCloseTo(10 + 1 / 60, 12);
    expect(value(metrics, "cost-per-request-p90")).toBe(6);
    expect(value(metrics, "requests-cost-known")).toBe(1);
    expect(value(metrics, "requests-cost")).toBe(6 + 1 + 2);
    expect(value(metrics, "requests-failed-runs")).toBe(1);
    expect(value(metrics, "waiting-on-people-share")).toBeCloseTo(4 / (10 + 1 / 60), 12);
    expect(value(metrics, "requests-touched", undefined, undefined)).toBe(4);
    expect(value(metrics, "requests-left-out", { reason: "an agent created it" }, undefined)).toBe(
      1,
    );
  });

  it("splits at a cutover into before, across and after", async () => {
    const cutover = T0 + 12 * HOUR;
    const { result } = await benchWith(benchState(), query(cutoverSplit(cutover, UNTIL)));
    const rows = table(result, "requests");
    expect(rows.map((row) => [row.request, row.segment, row.outcome])).toEqual([
      ["UXF-1", "before", "done"],
      ["UXF-2", "across", "open"],
      ["UXF-3", "after", "open"],
    ]);
    expect(value(result.metrics, "requests", undefined, "before")).toBe(1);
    expect(value(result.metrics, "requests-done", undefined, "before")).toBe(1);
    expect(value(result.metrics, "requests", undefined, "across")).toBe(1);
    expect(value(result.metrics, "requests", undefined, "after")).toBe(1);
    // No request is done after the cutover, so its lead time is n/a, not 0.
    expect(value(result.metrics, "lead-time-p50", undefined, "after")).toBeNull();
  });

  it("counts a request under the setup live when its first run started", async () => {
    const log = [
      { target: "team", setupHash: "aaa", sources: ["."], time: at(0.5) },
      { target: "team", setupHash: "bbb", sources: ["."], time: at(15) },
    ];
    const { result } = await benchWith(
      benchState(),
      query(compareSplit("team", log, ["aaa", "bbb"], UNTIL)),
    );
    const rows = table(result, "requests");
    // UXF-1 started before the first sync, so it counts under neither.
    expect(rows.map((row) => [row.request, row.segment])).toEqual([
      ["UXF-2", "aaa"],
      ["UXF-3", "bbb"],
    ]);
    expect(
      value(
        result.metrics,
        "requests-left-out",
        { reason: "started while neither compared setup was live" },
        undefined,
      ),
    ).toBe(1);
  });
});

describe("bench: timing", () => {
  it("measures each seat's runs, failures, review cycles and peak", async () => {
    const { result } = await benchWith(benchState());
    const runs = table(result, "runs");
    expect(runs).toHaveLength(9);
    const q0 = runs.find((row) => row.run === "q0");
    // A run that never started cost nothing.
    expect(q0).toMatchObject({ kind: "at quality_assurance", cost: 0, status: "cancelled" });
    expect(runs.find((row) => row.run === "b2")).toMatchObject({
      kind: "at in_progress",
      cost: null,
    });
    expect(runs.find((row) => row.run === "q2")?.kind).toBe("DELIVERY");
    expect(runs.find((row) => row.run === "q3")?.kind).toBe("wakeup");

    const { metrics } = result;
    expect(value(metrics, "runs")).toBe(9);
    expect(value(metrics, "runs", { seat: "QA" })).toBe(4);
    expect(value(metrics, "runs", { seat: "QA", kind: "at quality_assurance" })).toBe(2);
    expect(value(metrics, "failed-runs", { seat: "Builder" })).toBe(1);
    expect(value(metrics, "failure-causes", { seat: "Builder", reason: "runtime_offline" })).toBe(
      1,
    );
    // QA's runs that started and whose cost is known: q1 ($2) and q3 ($1). The cancelled one isn't a
    // run's cost, and q2's is unknown.
    expect(value(metrics, "run-cost", { seat: "QA" })).toBe(3);
    expect(value(metrics, "run-cost-p50", { seat: "QA" })).toBe(1);
    // b1, b2 and b4 overlap at 2h01.
    expect(value(metrics, "peak-concurrent-runs", { seat: "Builder" })).toBe(3);

    const cycles = table(result, "cycles");
    expect(cycles).toEqual([
      {
        issue: "UXF-1",
        segment: "all",
        kind: "at quality_assurance",
        wakeups: 0,
        total: 120,
        queue: 2,
        work: 118,
        ciGap: 0,
        cost: 2,
      },
      {
        issue: "UXF-2",
        segment: "all",
        kind: "DELIVERY",
        wakeups: 1,
        total: 30,
        queue: 2,
        work: 14 + 11,
        ciGap: 3,
        // q2 ran without reporting usage, so the cycle's cost is unknown, not $1.
        cost: null,
      },
    ]);
    expect(value(metrics, "review-cycles")).toBe(2);
    expect(value(metrics, "review-cycles-with-wakeup")).toBe(1);
    expect(value(metrics, "review-cycle-p90", { part: "total" })).toBe(120);
    expect(value(metrics, "review-cycle-share", { part: "ci-gap" })).toBeCloseTo(3 / 150, 12);
  });

  it("finds the review cycles at every --review-step", async () => {
    const state = benchState();
    state.timelines = {
      ...state.timelines,
      i1: [
        move(0, "backlog", "in_progress", "member"),
        move(4, "in_progress", "part_quality_assurance"),
        move(6, "part_quality_assurance", "in_review"),
        move(10, "in_review", "done", "member", MINUTE),
      ],
    };
    const one = await benchWith(state);
    expect(table(one.result, "cycles").map((c) => c.issue)).toEqual(["UXF-2"]);
    expect(one.result.notes?.join("\n")).toMatch(/QA ran at part_quality_assurance/);
    const both = await benchWith(
      state,
      query(wholeSplit(UNTIL), { reviewSteps: ["quality_assurance", "part_quality_assurance"] }),
    );
    expect(table(both.result, "cycles").map((c) => c.issue)).toEqual(["UXF-1", "UXF-2"]);
    expect(table(both.result, "requests")[0]?.reviewRounds).toBe(1);
  });
});

describe("bench: verdicts", () => {
  it("reads the verdicts and fixes, and keeps no text in the rows", async () => {
    const { result } = await benchWith(benchState());
    const rows = table(result, "verdicts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      events: [
        {
          type: "verdict",
          result: "FAIL",
          round: 1,
          report: "verdict-r1.md",
          blocking: [{ id: "B1", origin: "regression", state: "open", raisedRound: 1 }],
          nits: 1,
        },
        { type: "FIX", variant: "mechanical", answers: [{ id: "B1", answer: "fixed" }] },
        { type: "verdict", result: "PASS", round: 2 },
      ],
    });
    expect(JSON.stringify(rows)).not.toMatch(/secret|cache never clears|Looks good/);

    const { metrics } = result;
    expect(value(metrics, "first-verdicts")).toBe(1);
    expect(value(metrics, "first-verdicts", { result: "FAIL" })).toBe(1);
    expect(value(metrics, "first-fail-blockers", { origin: "regression" })).toBe(1);
    expect(value(metrics, "blockers-per-first-fail")).toBe(1);
    expect(value(metrics, "first-fails-only-mechanical")).toBe(0);
    expect(value(metrics, "blocker-outcomes", { state: "fixed" })).toBe(1);
    expect(value(metrics, "fix-answers", { answer: "fixed" })).toBe(1);
    expect(value(metrics, "issues-by-pass-round", { round: "PASS at round 2" })).toBe(1);
  });

  it("reports no verdict metric in a window without VERDICT comments, so they're n/a", async () => {
    const state = benchState();
    state.comments = { i1: [{ author_type: "member", created_at: at(6), content: "Ship it." }] };
    const { result } = await benchWith(state);
    expect(
      result.metrics.filter(
        (metric) => metric.id.includes("verdict") || metric.id.includes("fix-"),
      ),
    ).toEqual([]);
  });
});

describe("bench: reading Multica", () => {
  it("reads through the profile, in the target's workspace, without the run's variables, from $HOME", async () => {
    const { multica } = await benchWith(benchState());
    const calls = multica.calls();
    expect(calls.some((call) => call.args.join(" ").startsWith("issue timeline i1"))).toBe(true);
    for (const call of calls) {
      expect(call.profile).toBe("p1");
      expect(call.cwd).toBe(multica.home);
      for (const key of Object.keys(call.env)) expect(key).toBe("MULTICA_WORKSPACE_ID");
    }
    // It only reads.
    expect(
      multica
        .writes()
        .filter(
          (line) => !/^(issue (list|runs|timeline|comment list)|attachment download)\b/.test(line),
        ),
    ).toEqual([]);
  });

  it("stops when several profiles are logged in and none is named", async () => {
    const multica = fake(benchState(), ["p1", "p2"]);
    const connector = createConnector({ env: multica.env, desktop: "/nowhere/multica" });
    const { profile: _, ...noProfile } = query();
    await expect(connector.bench?.(noProfile)).rejects.toThrow(
      /several Multica profiles: pass --profile/,
    );
  });

  it("names the workspaces this profile reaches when the target's isn't one", async () => {
    const q = query();
    await expect(
      benchWith(benchState(), { ...q, target: { ...q.target, workspace: "elsewhere" } }),
    ).rejects.toThrow(/no workspace elsewhere for this profile: team/);
  });

  it("notes the issues whose timeline the server cut short", async () => {
    const state = benchState();
    state.truncated = { i1: "activities" };
    const { result } = await benchWith(state);
    expect(result.notes).toContain(
      "The server cut short a timeline in these requests, so their counts miss the oldest entries: UXF-1.",
    );
  });

  it("declares the metrics it reports, and the folders of its agents' runs", () => {
    const connector = createConnector();
    expect(connector.capabilities.metrics).toContain("lead-time-p50");
    expect(connector.capabilities.metrics).toContain("review-cycles");
    expect(connector.capabilities.metrics).toContain("first-verdicts");
    expect(connector.capabilities.metrics).not.toContain("sessions");
    expect(connector.runFolders?.test("-Users-me-multica-workspaces-desktop-x")).toBe(true);
  });
});
