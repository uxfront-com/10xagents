import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeCodeCollector, claudeProjectsDir } from "../src/bench/claude-code.ts";
import { compareSplit, wholeSplit } from "../src/bench/split.ts";
import type { BenchQuery, BenchResult, MetricResult } from "../src/contract.ts";
import { tempDir } from "./helpers.ts";

const SINCE = Date.parse("2026-11-01T00:00:00Z");
const UNTIL = Date.parse("2026-11-10T00:00:00Z");
const at = (day: number, minute = 0) =>
  new Date(
    Date.parse(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`) + minute * 60000,
  ).toISOString();
const CWD = "/runs/multica_workspaces_profile/team-0123456789ab/ab-12-0123456789ab/workdir";

const user = (timestamp: string, text: string) => ({
  type: "user",
  timestamp,
  cwd: CWD,
  message: { role: "user", content: text },
});
const call = (timestamp: string, id: string, usage: object, content: object[] = []) => ({
  type: "assistant",
  timestamp,
  message: { id, model: "claude-opus-5-5", usage, content },
});
const toolUse = (id: string, name: string, input: object) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const result = (timestamp: string, id: string, content: unknown) => ({
  type: "user",
  timestamp,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

const session = [
  user(at(2), "Start the work."),
  call(at(2, 1), "m1", { input_tokens: 10, cache_read_input_tokens: 1000 }, [
    toolUse("t1", "Read", { file_path: "/secret/client/AGENTS.md" }),
  ]),
  // Streaming repeats a call with its usage so far: the last line's counts.
  call(at(2, 1), "m1", {
    input_tokens: 10,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_1h_input_tokens: 200 },
  }),
  result(at(2, 2), "t1", "abcd"),
  call(at(2, 3), "m2", { input_tokens: 5, cache_read_input_tokens: 3000 }, [
    toolUse("t2", "Bash", { command: "cd /secret/x && git diff --stat /secret/path" }),
    toolUse("t3", "Skill", { skill: "adversarial-verification" }),
    toolUse("t4", "Read", { file_path: "/secret/client/AGENTS.md" }),
    toolUse("t5", "Bash", { command: "curlish https://private.example/token" }),
  ]),
  result(at(2, 4), "t2", [{ type: "text", text: "x".repeat(400) }, { type: "image" }]),
  result(at(2, 4), "t4", "abcd"),
  { type: "system", subtype: "compact_boundary", timestamp: at(2, 5) },
  {
    type: "user",
    timestamp: at(2, 6),
    isCompactSummary: true,
    message: { role: "user", content: "Summary" },
  },
  user(at(2, 7), "<task-notification>done</task-notification>"),
  // The second run in the window, on another day.
  user(at(5), "Fix the finding."),
  call(at(5, 1), "m3", { input_tokens: 7, cache_read_input_tokens: 500 }),
  // A run after the window, which stays out with its subagents.
  user(at(12), "Later."),
  call(at(12, 1), "m4", { input_tokens: 9999 }),
];
const subagent = [
  call(at(2, 3), "s1", { input_tokens: 100, output_tokens: 10 }),
  call(at(12, 2), "s2", { input_tokens: 5000 }),
];

const writeProjects = (): string => {
  const home = tempDir();
  const projects = join(home, "projects");
  const runs = join(projects, "-runs-multica-workspaces-profile-team");
  mkdirSync(join(runs, "sess-1", "subagents"), { recursive: true });
  writeFileSync(
    join(runs, "sess-1.jsonl"),
    `${session.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`,
  );
  writeFileSync(
    join(runs, "sess-1", "subagents", "agent-a.jsonl"),
    subagent.map((e) => JSON.stringify(e)).join("\n"),
  );
  const other = join(projects, "-home-someone-else");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "sess-2.jsonl"), JSON.stringify(user(at(3), "Not a platform run.")));
  return home;
};

const query = (split = wholeSplit(UNTIL)): BenchQuery & { runFolders?: RegExp } => ({
  target: { id: "t", workspace: "t", connector: "multica" },
  since: SINCE,
  until: UNTIL,
  split,
  reviewSteps: ["quality_assurance"],
  planSteps: ["plan_review"],
  runFolders: /multica.workspaces/i,
});

/** The sessions the collector reported, each as a record. */
const sessionsOf = (collected: BenchResult): Record<string, unknown>[] =>
  (collected.rows?.sessions ?? []).filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );

const value = (metrics: MetricResult[], id: string, by?: Record<string, string>) =>
  metrics.find(
    (metric) =>
      metric.id === id && JSON.stringify(metric.by ?? null) === JSON.stringify(by ?? null),
  )?.value;

describe("the Claude Code collector", () => {
  it("reads $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c/projects");
    expect(claudeProjectsDir({ HOME: "/h" })).toBe("/h/.claude/projects");
  });

  it("counts the runs in the window, their calls, context, compactions and subagents", async () => {
    const home = writeProjects();
    const collected = await claudeCodeCollector({
      env: { CLAUDE_CONFIG_DIR: home },
    }).collect(query());
    const { metrics, rows } = collected;
    const sessions = sessionsOf(collected);
    expect(sessions).toHaveLength(1);
    const [row] = sessions;
    expect(row).toMatchObject({
      session: "sess-1",
      segment: "all",
      issue: "AB-12",
      seat: "QA (by its skills)",
      compactions: 1,
      agentsMdReads: 2,
      repeatReads: 1,
      skillLoads: { "adversarial-verification": 1 },
      tools: {
        "Read AGENTS.md": 2,
        "Bash git diff": 1,
        "Bash another command": 1,
        "Skill adversarial-verification": 1,
      },
      outputs: {
        "Read AGENTS.md": { count: 2, chars: 8, max: 4, images: 0 },
        "Bash git diff": { count: 1, chars: 400, max: 400, images: 1 },
      },
      subagents: { calls: 1, models: ["claude-opus-5-5"] },
    });
    expect(row?.runs).toEqual([
      { start: at(2), calls: 2, contextAtStart: 1210, contextPeak: 3005 },
      { start: at(5), calls: 1, contextAtStart: 507, contextPeak: 507 },
    ]);
    // Nothing the agent typed reaches the report.
    expect(JSON.stringify(rows)).not.toMatch(/secret|private|token|client/);

    expect(value(metrics, "sessions")).toBe(1);
    expect(value(metrics, "session-runs")).toBe(2);
    const seat = { seat: "QA (by its skills)" };
    expect(value(metrics, "calls-per-run-p50", seat)).toBe(1);
    expect(value(metrics, "calls-per-run-p90", seat)).toBe(2);
    expect(value(metrics, "context-at-start-p90", seat)).toBe(1210);
    expect(value(metrics, "context-peak", seat)).toBe(3005);
    expect(value(metrics, "compactions", seat)).toBe(1);
    expect(value(metrics, "cache-write-1h-share", seat)).toBe(1);
    expect(value(metrics, "agents-md-reads-per-run", seat)).toBe(1);
    expect(value(metrics, "skill-loads-per-run", seat)).toBe(0.5);
    // Own: (22 input × 4 + 100 output × 20 + 4500 cache reads × 0.2 + 200 one-hour writes × 8) / 1e6.
    // Subagent: (100 × 4 + 10 × 20) / 1e6.
    const own = (22 * 4 + 100 * 20 + 4500 * 0.2 + 200 * 8) / 1e6;
    const sub = (100 * 4 + 10 * 20) / 1e6;
    expect(value(metrics, "session-cost", seat)).toBeCloseTo(own + sub, 12);
    expect(value(metrics, "subagent-cost-share", seat)).toBeCloseTo(sub / (own + sub), 12);
    expect(value(metrics, "tool-output-tokens", { tool: "Bash git diff" })).toBe(100);
    expect(value(metrics, "tool-output-images", { tool: "Bash git diff" })).toBe(1);
  });

  it("splits a session's runs by the segment each started in", async () => {
    const home = writeProjects();
    const log = [
      { target: "t", setupHash: "aaa", sources: ["."], time: at(1) },
      { target: "t", setupHash: "bbb", sources: ["."], time: at(4) },
    ];
    const collected = await claudeCodeCollector({
      env: { CLAUDE_CONFIG_DIR: home },
    }).collect(query(compareSplit("t", log, ["aaa", "bbb"], UNTIL)));
    const { metrics } = collected;
    // The subagent's call and the compaction happened in the first run.
    expect(sessionsOf(collected)).toMatchObject([
      { segment: "aaa", runs: [{ start: at(2) }], subagents: { calls: 1 }, compactions: 1 },
      { segment: "bbb", runs: [{ start: at(5) }], subagents: { calls: 0 }, compactions: 0 },
    ]);
    expect(metrics.filter((metric) => metric.id === "session-runs" && !metric.by)).toEqual([
      { id: "session-runs", segment: "aaa", value: 1 },
      { id: "session-runs", segment: "bbb", value: 1 },
    ]);
  });

  it("reads every project without the connector's folders", async () => {
    const home = writeProjects();
    const { runFolders: _, ...everywhere } = query();
    const collected = await claudeCodeCollector({ env: { CLAUDE_CONFIG_DIR: home } }).collect(
      everywhere,
    );
    expect(
      sessionsOf(collected)
        .map((row) => String(row.session))
        .toSorted(),
    ).toEqual(["sess-1", "sess-2"]);
  });

  it("reads a transcript bigger than its buffer, with characters split across reads", async () => {
    const home = tempDir();
    const runs = join(home, "projects", "-runs-multica-workspaces-profile-team");
    mkdirSync(runs, { recursive: true });
    // 1.5 million two-byte characters: the output crosses the 1 MB reads, mid-character.
    const big = "é".repeat(1_500_000);
    const lines = [
      user(at(2), "Start the work."),
      call(at(2, 1), "m1", { input_tokens: 1 }, [toolUse("t1", "Read", { file_path: "/a/b.md" })]),
      result(at(2, 2), "t1", big),
      call(at(2, 3), "m2", { input_tokens: 2 }),
    ];
    writeFileSync(join(runs, "big.jsonl"), lines.map((e) => JSON.stringify(e)).join("\n"));
    const collected = await claudeCodeCollector({ env: { CLAUDE_CONFIG_DIR: home } }).collect(
      query(),
    );
    expect(sessionsOf(collected)).toMatchObject([
      {
        session: "big",
        runs: [{ calls: 2 }],
        outputs: { "Read a .md file": { count: 1, chars: 1_500_000, max: 1_500_000 } },
      },
    ]);
  });

  it("reports nothing, and says why, without a projects folder", async () => {
    const collected = await claudeCodeCollector({
      env: { CLAUDE_CONFIG_DIR: join(tempDir(), "none") },
    }).collect(query());
    expect(collected.metrics).toEqual([]);
    expect(collected.notes?.[0]).toMatch(/No Claude Code projects folder at .*none\/projects/);
  });
});
