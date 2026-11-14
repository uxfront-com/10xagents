import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { METRICS } from "../src/bench/catalogue.ts";
import type { BenchReport } from "../src/bench/run.ts";
import { formatValue } from "../src/bench/run.ts";
import { compareSplit, cutoverSplit, parseMoment, wholeSplit } from "../src/bench/split.ts";
import { hashAt, matchHash, readSyncLog } from "../src/bench/sync-log.ts";
import type { BenchQuery, BenchResult, Collector, Connector } from "../src/contract.ts";
import { createMain } from "../src/main.ts";
import { ConnectorError } from "../src/registry.ts";
import { baseSetup, writeSetup } from "./helpers.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");

const fakeConnector = (overrides: Partial<Connector> = {}): Connector => ({
  id: "multica",
  capabilities: {
    sharedContext: true,
    workflowPerIssue: false,
    squads: true,
    skills: true,
    metrics: [],
  },
  pull: () => Promise.resolve({}),
  plan: () => Promise.resolve([]),
  apply: () => Promise.resolve(),
  ...overrides,
});

/** A collector that declares no metrics, like the Claude Code collector stubbed out. */
const silentCollector: Collector = {
  id: "claude-code",
  metrics: [],
  collect: () => Promise.reject(new Error("a collector with no metrics is never run")),
};

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    err.push(String(line));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const bench = async (
  dir: string,
  args: string[],
  connector: Connector = fakeConnector(),
  collectors: Collector[] = [silentCollector],
): Promise<number> => {
  const command = createMain({
    cwd: () => dir,
    loadConnector: (id) =>
      id === connector.id
        ? Promise.resolve(connector)
        : Promise.reject(new ConnectorError(`no connector ${id}`)),
    findConnectors: () => [connector.id],
    collectors: () => collectors,
    now: () => NOW,
  });
  await runCommand(command, { rawArgs: ["bench", ...args] });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
};

const isReport = (value: unknown): value is BenchReport =>
  !!value && typeof value === "object" && "metrics" in value && "rows" in value;
const report = (): BenchReport => {
  const parsed: unknown = JSON.parse(out.join(""));
  if (!isReport(parsed)) throw new Error("bench printed no report");
  return parsed;
};
const hashOf = (entry: unknown): string =>
  entry && typeof entry === "object" && "setupHash" in entry && typeof entry.setupHash === "string"
    ? entry.setupHash
    : "";

/** A setup with nothing but `targets/uxfront/target.yaml`, as the live parity run uses. */
const targetOnly = (extra: Record<string, string> = {}): string =>
  writeSetup({
    "targets/uxfront/target.yaml": "id: uxfront\nconnector: multica\nagents: []\nworkflows: []\n",
    ...extra,
  });

describe("bench", () => {
  it("shows every metric as n/a when the connector and collectors declare none", async () => {
    const dir = targetOnly();
    expect(await bench(dir, ["--dir", ".", "--since", "7", "--format", "json"])).toBe(0);
    const { metrics, segments } = report();
    expect(segments).toEqual(["all"]);
    expect(metrics.map((metric) => metric.id)).toEqual(METRICS.map((metric) => metric.id));
    for (const metric of metrics) {
      expect(metric).toMatchObject({ value: null, source: null, segment: "all" });
    }
  });

  it("prints n/a for each of them as text", async () => {
    expect(await bench(targetOnly(), ["--dir", ".", "--since", "7"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("Target uxfront (multica), 2026-11-13 12:00 to 2026-11-20 12:00 UTC");
    expect(text).toMatch(/^lead-time-p50 +n\/a$/m);
    expect(text).toMatch(/^context-at-start-p50 +n\/a$/m);
  });

  it("reads only the target's id, workspace and connector, and checks nothing else", async () => {
    const dir = targetOnly({
      "10xagents.config.ts": "export default {};\n",
      // Broken everywhere else, which validate would refuse.
      "agents/broken.yaml": "id: Not An Id\nname: 3\n",
      "workflows/flow/workflow.yaml": "columns: nope\n",
      "squad.md": "",
    });
    const queries: BenchQuery[] = [];
    const connector = fakeConnector({
      capabilities: { ...fakeConnector().capabilities, metrics: ["requests"] },
      bench: (query) => {
        queries.push(query);
        return Promise.resolve({ metrics: [{ id: "requests", segment: "all", value: 3 }] });
      },
    });
    expect(
      await bench(dir, ["--dir", ".", "--target", "uxfront", "--format", "json"], connector),
    ).toBe(0);
    expect(queries[0]?.target).toEqual({
      id: "uxfront",
      workspace: "uxfront",
      connector: "multica",
    });
    expect(report().metrics.find((metric) => metric.id === "requests")).toMatchObject({
      value: 3,
      source: "multica",
    });
  });

  it("passes the window, the steps and the profile to the connector", async () => {
    const queries: BenchQuery[] = [];
    const connector = fakeConnector({
      capabilities: { ...fakeConnector().capabilities, metrics: ["requests"] },
      bench: (query) => {
        queries.push(query);
        return Promise.resolve({ metrics: [] });
      },
    });
    const dir = writeSetup({
      "targets/t/target.yaml": "id: t\nworkspace: team\nconnector: multica\nagents: []\n",
    });
    const args = [
      "--dir",
      ".",
      "--since",
      "2026-11-01",
      "--until",
      "2026-11-10T12:00",
      "--review-step",
      "quality_assurance",
      "--review-step=part_quality_assurance",
      "--profile",
      "p1",
      "--format",
      "json",
    ];
    expect(await bench(dir, args, connector)).toBe(0);
    const query = queries[0];
    expect(query?.target.workspace).toBe("team");
    expect(query?.since).toBe(new Date(2026, 10, 1).getTime());
    expect(query?.until).toBe(new Date(2026, 10, 10, 12).getTime());
    expect(query?.reviewSteps).toEqual(["quality_assurance", "part_quality_assurance"]);
    expect(query?.planSteps).toEqual(["plan_review"]);
    expect(query?.profile).toBe("p1");
    // The requests metric came back empty, so it's n/a; the rest have no source.
    expect(report().metrics.find((metric) => metric.id === "requests")).toMatchObject({
      value: null,
      source: "multica",
    });
  });

  it("keeps the collectors' rows and notes beside the connector's", async () => {
    const collector: Collector = {
      id: "claude-code",
      metrics: ["sessions"],
      collect: (query) =>
        Promise.resolve({
          metrics: [{ id: "sessions", segment: "all", value: 2 }],
          rows: { sessions: [{ session: "s1" }, { session: "s2" }] },
          notes: [`folders: ${String(query.runFolders)}`],
        }),
    };
    const connector = fakeConnector({ runFolders: /runs/ });
    expect(
      await bench(targetOnly(), ["--dir", ".", "--format", "json"], connector, [collector]),
    ).toBe(0);
    const result = report();
    expect(result.metrics.find((metric) => metric.id === "sessions")?.value).toBe(2);
    expect(result.rows["claude-code"]?.sessions).toHaveLength(2);
    expect(result.notes).toEqual(["folders: /runs/"]);
  });

  it("names the wrong flag and exits 1", async () => {
    const dir = targetOnly();
    expect(await bench(dir, ["--dir", ".", "--since", "tomorrow"])).toBe(1);
    expect(err.at(-1)).toMatch(/--since takes a number of days/);
    expect(await bench(dir, ["--dir", ".", "--since", "3", "--until", "5"])).toBe(1);
    expect(err.at(-1)).toMatch(/--until takes a moment after --since/);
    expect(await bench(dir, ["--dir", ".", "--since", "7", "--cutover", "3"])).toBe(1);
    expect(err.at(-1)).toMatch(/--cutover takes a date and time/);
    expect(await bench(dir, ["--dir", ".", "--since", "7", "--cutover", "2026-01-01"])).toBe(1);
    expect(err.at(-1)).toMatch(/between --since and --until/);
    expect(await bench(dir, ["--dir", ".", "--compare", "a", "b"])).toBe(1);
    expect(err.at(-1)).toMatch(/--compare needs .*sync-log\.jsonl/);
    writeFileSync(
      join(dir, "sync-log.jsonl"),
      `${JSON.stringify({ target: "uxfront", setupHash: "abc", sources: ["."], time: "2026-11-15T00:00:00Z" })}\n`,
    );
    expect(await bench(dir, ["--dir", ".", "--compare", "abc"])).toBe(1);
    expect(err.at(-1)).toMatch(/--compare takes two setup hashes/);
    expect(
      await bench(dir, [
        "--dir",
        ".",
        "--since",
        "9",
        "--cutover",
        "2026-11-15",
        "--compare",
        "a",
        "b",
      ]),
    ).toBe(1);
    expect(err.at(-1)).toBe("Pass --cutover or --compare, not both.");
    expect(await bench(dir, ["--dir", ".", "--format", "yaml"])).toBe(1);
    expect(err.at(-1)).toBe("--format takes text or json.");
    expect(await bench(join(dir, "nowhere"), ["--dir", "."])).toBe(1);
    expect(err.at(-1)).toMatch(/bench reads a setup folder/);
    expect(await bench(writeSetup({ "targets/x/target.yaml": "id: X\n" }), ["--dir", "."])).toBe(1);
    expect(err.at(-1)).toMatch(/target\.yaml: id: must be lower case/);
  });

  it("stops with the connector's error, and exits 1", async () => {
    const connector = fakeConnector({
      capabilities: { ...fakeConnector().capabilities, metrics: ["requests"] },
      bench: () => Promise.reject(new Error("several Multica profiles: pass --profile")),
    });
    expect(await bench(targetOnly(), ["--dir", "."], connector)).toBe(1);
    expect(err).toEqual(["Stopped: several Multica profiles: pass --profile"]);
  });
});

describe("--compare", () => {
  const log = [
    { target: "uxfront", setupHash: "aaaa1111", sources: ["."], time: "2026-11-05T00:00:00Z" },
    { target: "uxfront", setupHash: "bbbb2222", sources: ["."], time: "2026-11-10T00:00:00Z" },
  ];
  const runs = [
    { id: "before-any-sync", start: "2026-11-04T12:00:00Z" },
    { id: "on-a-1", start: "2026-11-05T00:00:00Z" },
    { id: "on-a-2", start: "2026-11-09T23:59:59Z" },
    { id: "on-b", start: "2026-11-12T08:00:00Z" },
  ];

  it("counts each run under the hash live at its start, and one before the first sync under neither", async () => {
    const dir = targetOnly({
      "sync-log.jsonl": `${log.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    });
    const connector = fakeConnector({
      capabilities: { ...fakeConnector().capabilities, metrics: ["runs"] },
      bench: ({ split }): Promise<BenchResult> => {
        const counted = runs.map((run) => ({
          ...run,
          segment: split.segmentOf(Date.parse(run.start)),
        }));
        return Promise.resolve({
          metrics: split.segments.map((segment) => ({
            id: "runs",
            segment,
            value: counted.filter((run) => run.segment === segment).length,
          })),
          rows: { runs: counted },
        });
      },
    });
    const args = ["--dir", ".", "--since", "2026-11-01", "--compare", "aaaa", "bbbb2222"];
    expect(await bench(dir, [...args, "--format", "json"], connector)).toBe(0);
    const result = report();
    expect(result.segments).toEqual(["aaaa1111", "bbbb2222"]);
    expect(result.compare).toEqual(["aaaa1111", "bbbb2222"]);
    expect(result.metrics.filter((metric) => metric.id === "runs")).toEqual([
      {
        id: "runs",
        group: "cost-time",
        unit: "count",
        segment: "aaaa1111",
        value: 2,
        source: "multica",
      },
      {
        id: "runs",
        group: "cost-time",
        unit: "count",
        segment: "bbbb2222",
        value: 1,
        source: "multica",
      },
    ]);
    expect(result.rows.multica?.runs).toEqual(
      [
        { ...runs[0], segment: undefined },
        { ...runs[1], segment: "aaaa1111" },
        { ...runs[2], segment: "aaaa1111" },
        { ...runs[3], segment: "bbbb2222" },
      ].map((run) => JSON.parse(JSON.stringify(run)) as unknown),
    );
  });

  it("leaves out runs under a hash it doesn't compare", () => {
    const entries = [
      ...log,
      { target: "uxfront", setupHash: "cccc3333", sources: ["."], time: "2026-11-15T00:00:00Z" },
    ];
    const split = compareSplit(entries, ["aaaa1111", "cccc3333"], NOW);
    expect(split.segmentOf(Date.parse("2026-11-12T00:00:00Z"))).toBeUndefined();
    expect(split.segmentOf(Date.parse("2026-11-16T00:00:00Z"))).toBe("cccc3333");
    expect(split.placeRequest(Date.parse("2026-11-06T00:00:00Z"), () => true)).toEqual({
      segment: "aaaa1111",
      horizon: NOW,
    });
    expect(split.placeRequest(Date.parse("2026-11-01T00:00:00Z"), () => true)).toBeUndefined();
  });

  it("takes a unique prefix, and refuses one that matches two hashes or none", () => {
    const hashes = ["abc123", "abd456"];
    expect(matchHash("abc", hashes)).toBe("abc123");
    expect(() => matchHash("ab", hashes)).toThrow(/matches 2 setup hashes/);
    expect(() => matchHash("ff", hashes)).toThrow(/no setup hash/);
    expect(() => matchHash("", hashes)).toThrow(/no setup hash/);
  });

  it("refuses the same hash twice, and a log line that isn't an entry", async () => {
    const dir = targetOnly({ "sync-log.jsonl": `${JSON.stringify(log[0])}\n` });
    expect(await bench(dir, ["--dir", ".", "--since", "30", "--compare", "aaaa", "aaaa1111"])).toBe(
      1,
    );
    expect(err.at(-1)).toBe("--compare takes two different setup hashes.");
    writeFileSync(join(dir, "sync-log.jsonl"), '{"target":"uxfront"}\n');
    expect(() => readSyncLog(dir)).toThrow(/sync-log\.jsonl:1: not a sync-log entry/);
    expect(await bench(dir, ["--dir", ".", "--since", "30", "--compare", "a", "b"])).toBe(1);
  });

  it("reads the log oldest first, and knows no hash before its first entry", () => {
    const dir = targetOnly({
      "sync-log.jsonl": `${JSON.stringify(log[1])}\n\n${JSON.stringify(log[0])}\n`,
    });
    const entries = readSyncLog(dir);
    expect(entries.map((entry) => entry.setupHash)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(hashAt(entries, Date.parse("2026-11-01T00:00:00Z"))).toBeUndefined();
    expect(hashAt(entries, Date.parse("2026-11-10T00:00:00Z"))).toBe("bbbb2222");
  });
});

describe("--cutover", () => {
  const cutover = Date.parse("2026-11-08T12:00:00Z");
  const until = Date.parse("2026-11-22T12:00:00Z");
  // Each request: when its first run started, and when it closed, if it did.
  const requests = [
    { id: "done-before", start: "2026-11-01T00:00:00Z", closed: "2026-11-05T00:00:00Z" },
    { id: "open-at-cutover", start: "2026-11-02T00:00:00Z", closed: "2026-11-12T00:00:00Z" },
    { id: "never-closed", start: "2026-11-03T00:00:00Z", closed: null },
    { id: "closed-at-the-cutover", start: "2026-11-04T00:00:00Z", closed: "2026-11-08T12:00:00Z" },
    { id: "started-at-the-cutover", start: "2026-11-08T12:00:00Z", closed: null },
    { id: "after", start: "2026-11-10T00:00:00Z", closed: "2026-11-11T00:00:00Z" },
  ];

  it("splits requests into before, across and after, each judged at its horizon", () => {
    const split = cutoverSplit(cutover, until);
    expect(split.segments).toEqual(["before", "across", "after"]);
    const placed = requests.map((request) => {
      const closed = request.closed === null ? Infinity : Date.parse(request.closed);
      return [
        request.id,
        split.placeRequest(Date.parse(request.start), (t) => t < closed),
      ] as const;
    });
    expect(Object.fromEntries(placed)).toEqual({
      "done-before": { segment: "before", horizon: cutover },
      "open-at-cutover": { segment: "across", horizon: until },
      "never-closed": { segment: "across", horizon: until },
      "closed-at-the-cutover": { segment: "before", horizon: cutover },
      "started-at-the-cutover": { segment: "after", horizon: until },
      after: { segment: "after", horizon: until },
    });
  });

  it("puts runs and sessions before or after it by their start", () => {
    const split = cutoverSplit(cutover, until);
    expect(split.segmentOf(cutover - 1)).toBe("before");
    expect(split.segmentOf(cutover)).toBe("after");
  });

  it("gives the connector the split, and reports each segment", async () => {
    const connector = fakeConnector({
      capabilities: { ...fakeConnector().capabilities, metrics: ["requests"] },
      bench: ({ split }) =>
        Promise.resolve({
          metrics: requests.flatMap((request) => {
            const closed = request.closed === null ? Infinity : Date.parse(request.closed);
            const placed = split.placeRequest(Date.parse(request.start), (t) => t < closed);
            return placed ? [{ id: "requests", segment: placed.segment, value: 1 }] : [];
          }),
        }),
    });
    const args = ["--dir", ".", "--since", "2026-10-25T12:00", "--cutover", "2026-11-08T14:00"];
    expect(
      await bench(
        targetOnly(),
        [...args, "--until", "2026-11-22T12:00", "--format", "json"],
        connector,
      ),
    ).toBe(0);
    const result = report();
    expect(result.segments).toEqual(["before", "across", "after"]);
    expect(result.cutover).toBe(new Date(2026, 10, 8, 14).toISOString());
  });
});

describe("the window", () => {
  it("reads days back, a local date at midnight, and a local date and time", () => {
    expect(parseMoment("2", NOW)).toBe(NOW - 2 * 86_400_000);
    expect(parseMoment("0.5", NOW)).toBe(NOW - 43_200_000);
    expect(parseMoment("2026-11-14", NOW)).toBe(new Date(2026, 10, 14).getTime());
    expect(parseMoment("2026-11-14T09:30", NOW)).toBe(new Date(2026, 10, 14, 9, 30).getTime());
    expect(parseMoment("2026-11-14T09:30Z", NOW)).toBe(Date.parse("2026-11-14T09:30Z"));
    expect(parseMoment("soon", NOW)).toBeNaN();
  });

  it("puts everything in one segment without a split", () => {
    const split = wholeSplit(NOW);
    expect(split.segmentOf(0)).toBe("all");
    expect(split.placeRequest(0, () => true)).toEqual({ segment: "all", horizon: NOW });
  });

  it("formats values as the old scripts printed them", () => {
    expect(formatValue("hours", 3.25)).toBe("3.3h");
    expect(formatValue("hours", 60)).toBe("2.5d");
    expect(formatValue("minutes", 89.94)).toBe("89.9m");
    expect(formatValue("minutes", 120)).toBe("2.0h");
    expect(formatValue("usd", 4.126)).toBe("$4.13");
    expect(formatValue("usd", 1163.4)).toBe("$1163");
    expect(formatValue("ratio", 0.405)).toBe("41%");
    expect(formatValue("tokens", 229_400)).toBe("229k");
    expect(formatValue("count", 3)).toBe("3");
    expect(formatValue("count", 0.0512)).toBe("0.05");
    expect(formatValue("count", null)).toBe("n/a");
  });
});

const syncing = () => {
  let pending = [{ kind: "agent", id: "alpha", summary: "~ Alpha" }];
  const connector = fakeConnector({
    id: "fake",
    plan: () => Promise.resolve([...pending]),
    apply: () => {
      pending = [];
      return Promise.resolve();
    },
  });
  return connector;
};
const sync = async (dir: string, args: string[], connector: Connector) => {
  const command = createMain({
    cwd: () => dir,
    loadConnector: () => Promise.resolve(connector),
    findConnectors: () => ["fake"],
    collectors: () => [],
    now: () => NOW,
  });
  await runCommand(command, { rawArgs: ["sync", "--dir", ".", ...args] });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
};
const lines = (dir: string): unknown[] => {
  try {
    return readFileSync(join(dir, "sync-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  } catch {
    return [];
  }
};

describe("sync-log.jsonl", () => {
  it("gets one line per sync that applies, with no path of this machine", async () => {
    const dir = writeSetup(baseSetup());
    expect(await sync(dir, ["--yes"], syncing())).toBe(0);
    const [entry] = lines(dir);
    expect(lines(dir)).toHaveLength(1);
    expect(entry).toEqual({
      target: "t",
      setupHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      sources: ["."],
      time: new Date(NOW).toISOString(),
    });
    // Nothing left to apply: no line.
    const connector = syncing();
    await connector.apply([]);
    expect(await sync(dir, ["--yes"], connector)).toBe(0);
    expect(lines(dir)).toHaveLength(1);
  });

  it("gets nothing with --dry-run, on a no, or when every change failed", async () => {
    const dir = writeSetup(baseSetup());
    expect(await sync(dir, ["--dry-run"], syncing())).toBe(0);
    const failing = fakeConnector({
      id: "fake",
      plan: () => Promise.resolve([{ kind: "agent", id: "alpha", summary: "~ Alpha" }]),
      apply: (changes) =>
        Promise.resolve({ failed: changes.map((change) => ({ change, message: "refused" })) }),
    });
    expect(await sync(dir, ["--yes"], failing)).toBe(1);
    expect(lines(dir)).toEqual([]);
  });

  it("gives the same setup the same hash, and a changed one another", async () => {
    const one = writeSetup(baseSetup());
    const two = writeSetup(baseSetup());
    await sync(one, ["--yes"], syncing());
    await sync(two, ["--yes"], syncing());
    const hash = (dir: string) => hashOf(lines(dir)[0]);
    expect(hash(one)).toBe(hash(two));
    mkdirSync(join(two, "skills", "extra"), { recursive: true });
    writeFileSync(join(two, "skills", "extra", "SKILL.md"), "---\nname: extra\n---\n");
    await sync(two, ["--yes"], syncing());
    expect(hashOf(lines(two)[1])).not.toBe(hash(one));
  });
});
