import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { renderUsage, runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pkg from "../package.json" with { type: "json" };
import { readSyncLog } from "../src/bench/sync-log.ts";
import { configText } from "../src/config.ts";
import type { Change, Connector, PullOptions } from "../src/contract.ts";
import { createMain, main, terminalAsk } from "../src/main.ts";
import { ConnectorError } from "../src/registry.ts";
import { baseSetup, FIXTURES, tempDir, writeSetup } from "./helpers.ts";

const fakeConnector = (overrides: Partial<Connector> = {}): Connector => ({
  id: "fake",
  capabilities: {
    sharedContext: false,
    workflowPerIssue: false,
    squads: true,
    skills: false,
    metrics: ["pass-rate"],
  },
  pull: () => Promise.resolve({}),
  plan: () => Promise.resolve([]),
  apply: () => Promise.resolve(),
  ...overrides,
});

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

/** Runs the CLI in `cwd` with connectors from `connectors`, and returns its exit code. */
const cli = async (
  cwd: string,
  rawArgs: string[],
  connectors: Record<string, Connector> = {
    fake: fakeConnector(),
    multica: fakeConnector({ id: "multica" }),
  },
  ask?: (question: string) => Promise<string>,
): Promise<number> => {
  const command = createMain({
    cwd: () => cwd,
    ask,
    loadConnector: (id) => {
      const connector = connectors[id];
      return connector
        ? Promise.resolve(connector)
        : Promise.reject(
            new ConnectorError(`no connector ${id}: install @10xagents/connector-${id}`),
          );
    },
    findConnectors: () => Object.keys(connectors).toSorted(),
    sources: () => ({
      fetcher: {
        resolveRef: () => Promise.reject(new Error("no network in tests")),
        download: () => Promise.reject(new Error("no network in tests")),
      },
      cacheDir: join(cwd, ".cache"),
      bundledDir: join(cwd, ".bundled"),
    }),
  });
  await runCommand(command, { rawArgs });
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return Number(code);
};

const readTree = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [file.slice(dir.length + 1), readFileSync(file, "utf8")] as const;
      })
      .toSorted(([a], [b]) => (a < b ? -1 : 1)),
  );

describe("10xagents", () => {
  it("names itself, its version and all eight commands in the help", async () => {
    const usage = await renderUsage(main);
    expect(usage).toContain("10xagents");
    expect(usage).toContain(pkg.version);
    for (const command of [
      "init",
      "install",
      "validate",
      "build",
      "plan",
      "sync",
      "bench",
      "connectors",
    ]) {
      expect(usage).toContain(command);
    }
  });

  it("bench exits 1 without a setup folder", async () => {
    const dir = tempDir();
    expect(await cli(dir, ["bench"])).toBe(1);
    expect(err).toEqual([
      `${join(dir, ".10xagents")}: bench reads a setup folder on this machine, and there's none here`,
    ]);
  });
});

describe("terminalAsk", () => {
  it("asks on standard error, so standard output carries only the command's output", async () => {
    const asked: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      asked.push(String(chunk));
      return true;
    });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const ask = terminalAsk(input);
    const answer = ask?.("  1. p1\n  2. p2\nProfile (number): ");
    input.write(" 2 \n");
    expect(await answer).toBe("2");
    expect(asked.join("")).toContain("  1. p1\n  2. p2\nProfile (number): ");
    expect(out).toEqual([]);
  });

  it("is missing when the input isn't a terminal", () => {
    expect(terminalAsk(new PassThrough())).toBeUndefined();
  });
});

describe("validate", () => {
  it("exits 0 on a valid setup", async () => {
    expect(await cli(FIXTURES, ["validate", "--dir", "ok"])).toBe(0);
    expect(out.join("")).toBe("Valid: 3 agents, 1 workflows, 1 target.\n");
  });

  it("exits 1 with one line per error, relative to the working directory", async () => {
    expect(await cli(FIXTURES, ["validate", "--dir", "broken"])).toBe(1);
    expect(err).toHaveLength(13);
    expect(err).toContain(
      "broken/agents/missing-trait.yaml: traits[0]: no trait nope in targets/broken/traits/ or traits/",
    );
    expect(err.at(-1)).toBe("12 errors.");
  });

  it("checks only the target it's given", async () => {
    const dir = writeSetup({
      ...baseSetup(),
      "targets/u/target.yaml": "id: u\nconnector: fake\nagents: [ghost]\n",
    });
    expect(await cli(dir, ["validate", "--dir", ".", "--target", "t"])).toBe(0);
    expect(await cli(dir, ["validate", "--dir", "."])).toBe(1);
    expect(err).toContain("targets/u/target.yaml: agents[0]: no agent ghost in agents/");
  });

  it("defaults to ./.10xagents", async () => {
    const dir = tempDir();
    expect(await cli(dir, ["validate"])).toBe(1);
    expect(err[0]).toBe(".10xagents: (dir): is not a setup directory: it doesn't exist");
  });
});

describe("build", () => {
  it("writes the same files twice", async () => {
    const work = tempDir();
    const dir = join(FIXTURES, "ok");
    expect(await cli(work, ["build", "--dir", dir, "--target", "ok", "--out", "b1"])).toBe(0);
    expect(await cli(work, ["build", "--dir", dir, "--target", "ok", "--out", "b2"])).toBe(0);
    const first = readTree(join(work, "b1"));
    expect(Object.keys(first)).toEqual([
      "agents/builder.md",
      "agents/lead.md",
      "agents/planner.md",
      "squad.md",
      "workflows/request.json",
    ]);
    expect(readTree(join(work, "b2"))).toEqual(first);
  });

  it("puts globals in shared-context.md when the connector has a shared context", async () => {
    const work = tempDir();
    const shared = fakeConnector({
      id: "multica",
      capabilities: { ...fakeConnector().capabilities, sharedContext: true },
    });
    expect(
      await cli(work, ["build", "--dir", join(FIXTURES, "ok"), "--out", "dist"], {
        multica: shared,
      }),
    ).toBe(0);
    const files = readTree(join(work, "dist"));
    expect(files["shared-context.md"]).toBe(
      "Robin owns this workspace, and decides what ships.\n\nRequests start in Todo.\n\nThis target runs locally.",
    );
    expect(files["agents/lead.md"]).not.toContain("Robin owns");
  });

  it("uses the connector's column names", async () => {
    const work = tempDir();
    const named = fakeConnector({
      columnNames: (workflows) =>
        Object.fromEntries(
          workflows.map((workflow) => [
            workflow.id,
            Object.fromEntries(
              workflow.columns.map((column) => [column.key, column.key.toUpperCase()]),
            ),
          ]),
        ),
    });
    const dir = writeSetup({
      ...baseSetup(),
      "workflows/flow/steps/todo.md": "{{workflows.flow.columns.review}}",
    });
    expect(await cli(work, ["build", "--dir", dir, "--out", "dist"], { fake: named })).toBe(0);
    expect(readTree(join(work, "dist"))["workflows/flow.json"]).toContain(
      '"instructions": "REVIEW"',
    );
  });

  it("exits 1 on a broken setup, and writes nothing", async () => {
    const work = tempDir();
    expect(await cli(work, ["build", "--dir", join(FIXTURES, "broken"), "--out", "dist"])).toBe(1);
    expect(err.at(-1)).toBe("12 errors.");
    expect(readdirSync(work)).toEqual([]);
  });

  it("exits 1 when the target's connector isn't installed", async () => {
    const work = tempDir();
    expect(await cli(work, ["build", "--dir", join(FIXTURES, "ok"), "--out", "dist"], {})).toBe(1);
    expect(err).toEqual(["no connector multica: install @10xagents/connector-multica"]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("asks for --target when there are several, and names an unknown one", async () => {
    const dir = writeSetup({
      ...baseSetup(),
      "targets/u/target.yaml": "id: u\nconnector: fake\nagents: [alpha]\n",
    });
    expect(await cli(dir, ["build", "--dir", "."])).toBe(1);
    expect(err).toEqual(["Choose a target with --target: t, u."]);
    err.length = 0;
    expect(await cli(dir, ["build", "--dir", ".", "--target", "v"])).toBe(1);
    expect(err[0]).toBe("targets: v: is not a target of this setup");
  });

  it("refuses to write into the setup's own directory", async () => {
    const dir = writeSetup(baseSetup());
    expect(await cli(dir, ["build", "--dir", ".", "--out", "."])).toBe(1);
    expect(err).toEqual(["--out must not be the setup's own directory: its files would mix."]);
  });

  it("names the missing target folder in a setup with none", async () => {
    const dir = writeSetup({ "agents/.keep": "" });
    expect(await cli(dir, ["build", "--dir", "."])).toBe(1);
    expect(err).toEqual(["The setup has no targets: add targets/<slug>/target.yaml."]);
  });
});

describe("connectors", () => {
  it("lists each connector's capabilities", async () => {
    expect(await cli(tempDir(), ["connectors"])).toBe(0);
    expect(out).toEqual([
      "fake: sharedContext: no, workflowPerIssue: no, squads: yes, skills: no, metrics: pass-rate\n",
      "multica: sharedContext: no, workflowPerIssue: no, squads: yes, skills: no, metrics: pass-rate\n",
    ]);
  });

  it("says when none is installed", async () => {
    expect(await cli(tempDir(), ["connectors"], {})).toBe(0);
    expect(out).toEqual([
      "No connectors installed. Install one, like @10xagents/connector-multica.\n",
    ]);
  });
});

/** A connector whose live state is a list of changes still to make. */
const liveConnector = (
  initial: Change[],
  options: {
    failOn?: string;
    /** The failed change no longer differs afterwards, like a write that went through anyway. */
    failGone?: boolean;
    stick?: string;
    pullError?: string;
  } = {},
) => {
  let pending = [...initial];
  const pulls: PullOptions[] = [];
  const applied: Change[][] = [];
  const connector = fakeConnector({
    pull: (_target, pullOptions = {}) => {
      pulls.push(pullOptions);
      if (options.pullError) return Promise.reject(new Error(options.pullError));
      pullOptions.log?.("Workspace: Test");
      return Promise.resolve({});
    },
    plan: () => Promise.resolve([...pending]),
    apply: (changes) => {
      applied.push(changes);
      const failed = changes
        .filter((change) => change.id === options.failOn)
        .map((change) => ({ change, message: "refused" }));
      pending = pending.filter(
        (change) =>
          change.manual ||
          change.note ||
          (change.id === options.failOn && !options.failGone) ||
          change.id === options.stick,
      );
      return Promise.resolve({ failed });
    },
  });
  return { connector, pulls, applied };
};

const agentChange: Change = {
  kind: "agent",
  id: "alpha",
  summary: "~ Alpha instructions (1 line differs)",
  diff: "-old\n+new",
};
const contextChange: Change = { kind: "context", id: "context", summary: "~ Agent context" };
const manualChange: Change = {
  kind: "agent",
  id: "beta",
  summary: "! Beta: no agent with this name; create it first",
  manual: true,
};
const noteChange: Change = {
  kind: "project",
  id: "p",
  summary: "· Side: on another workflow",
  note: true,
};

describe("plan", () => {
  it("lists the changes and the notes, and exits 0", async () => {
    const { connector, pulls } = liveConnector([agentChange, noteChange, contextChange]);
    const dir = writeSetup(baseSetup());
    expect(
      await cli(dir, ["plan", "--dir", ".", "--profile", "p", "--workspace", "w"], {
        fake: connector,
      }),
    ).toBe(0);
    expect(out.join("")).toBe(
      [
        "Workspace: Test",
        "  · Side: on another workflow",
        "2 changes:",
        "  ~ Alpha instructions (1 line differs)",
        "  ~ Agent context",
        "",
      ].join("\n"),
    );
    expect(pulls[0]).toMatchObject({ profile: "p", workspace: "w" });
  });

  it("prints each diff with --diff", async () => {
    const { connector } = liveConnector([agentChange]);
    expect(
      await cli(writeSetup(baseSetup()), ["plan", "--dir", ".", "--diff"], { fake: connector }),
    ).toBe(0);
    expect(out.join("")).toContain(
      "  ~ Alpha instructions (1 line differs)\n      -old\n      +new\n",
    );
  });

  it("says when the platform is up to date", async () => {
    const { connector } = liveConnector([]);
    expect(await cli(writeSetup(baseSetup()), ["plan", "--dir", "."], { fake: connector })).toBe(0);
    expect(out.join("")).toBe("Workspace: Test\nUp to date.\n");
  });

  it("exits 1 on a ! line", async () => {
    const { connector } = liveConnector([manualChange]);
    expect(await cli(writeSetup(baseSetup()), ["plan", "--dir", "."], { fake: connector })).toBe(1);
    expect(out.join("")).toContain(
      "  ! Beta: no agent with this name; create it first\n1 item needs setup first (see the ! lines above).\n",
    );
  });

  it("exits 1 when the platform can't be read", async () => {
    const { connector } = liveConnector([], { pullError: "several profiles: pass --profile" });
    expect(await cli(writeSetup(baseSetup()), ["plan", "--dir", "."], { fake: connector })).toBe(1);
    expect(err).toEqual(["Stopped: several profiles: pass --profile"]);
  });

  it("reports what the connector's platform would refuse, before reading it", async () => {
    const { connector, pulls } = liveConnector([agentChange]);
    const dir = writeSetup(baseSetup());
    connector.validate = () => [
      { field: "workflows.flow.steps.todo", message: "is too long" },
      { file: join(dir, "skills/x/SKILL.md"), field: "name", message: "must match" },
    ];
    expect(await cli(dir, ["plan", "--dir", "."], { fake: connector })).toBe(1);
    expect(err).toEqual([
      "targets/t/target.yaml: workflows.flow.steps.todo: is too long",
      "skills/x/SKILL.md: name: must match",
      "2 errors.",
    ]);
    expect(pulls).toEqual([]);
    expect(await cli(dir, ["build", "--dir", ".", "--out", "out"], { fake: connector })).toBe(1);
  });
});

const yes = () => Promise.resolve("y");

describe("sync", () => {
  it("applies nothing with --dry-run", async () => {
    const { connector, applied } = liveConnector([agentChange]);
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--dry-run"], { fake: connector }),
    ).toBe(0);
    expect(applied).toEqual([]);
  });

  it("applies nothing without --yes when there's no terminal to ask in", async () => {
    const { connector, applied } = liveConnector([agentChange]);
    expect(await cli(writeSetup(baseSetup()), ["sync", "--dir", "."], { fake: connector })).toBe(1);
    expect(applied).toEqual([]);
    expect(err).toEqual(["No terminal to ask in: pass --yes to apply, or --dry-run to only look."]);
  });

  it("asks first, and applies nothing unless the answer is yes", async () => {
    const { connector, applied } = liveConnector([agentChange]);
    const questions: string[] = [];
    const no = (question: string) => {
      questions.push(question);
      return Promise.resolve("n");
    };
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", "."], { fake: connector }, no),
    ).toBe(0);
    expect(questions).toEqual(["Apply 1 change to t? [y/N] "]);
    expect(applied).toEqual([]);
    expect(out.join("")).toContain("Skipped.");
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", "."], { fake: connector }, yes),
    ).toBe(0);
    expect(applied).toEqual([[agentChange]]);
  });

  it("applies only the changes with --yes, then checks again", async () => {
    const { connector, applied, pulls } = liveConnector([agentChange, noteChange, contextChange]);
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(0);
    expect(applied).toEqual([[agentChange, contextChange]]);
    expect(pulls).toHaveLength(2);
    expect(out.join("")).toContain("Applied; t now matches the setup.\n");
  });

  it("names the workspace the connector read, and re-checks it through the same account", async () => {
    const { connector, pulls, applied } = liveConnector([agentChange]);
    connector.place = () => ({ name: "Team", pull: { profile: "p2", workspace: "ws-1" } });
    const questions: string[] = [];
    const ask = (question: string) => {
      questions.push(question);
      return Promise.resolve("y");
    };
    expect(
      await cli(
        writeSetup(baseSetup()),
        ["sync", "--dir", ".", "--workspace", "team"],
        { fake: connector },
        ask,
      ),
    ).toBe(0);
    expect(questions).toEqual(["Apply 1 change to Team? [y/N] "]);
    expect(applied).toHaveLength(1);
    expect(pulls).toHaveLength(2);
    expect(pulls[0]).toMatchObject({ workspace: "team" });
    expect(pulls[0]?.ask).toBe(ask);
    // The re-check reads the same place, and has nothing to ask.
    expect(pulls[1]).toEqual({ profile: "p2", workspace: "ws-1", log: expect.any(Function) });
    expect(out.join("")).toContain("Applied; Team now matches the setup.\n");
  });

  it("names the --workspace given when the connector can't say where it read", async () => {
    const { connector } = liveConnector([agentChange]);
    const questions: string[] = [];
    const no = (question: string) => {
      questions.push(question);
      return Promise.resolve("");
    };
    await cli(
      writeSetup(baseSetup()),
      ["sync", "--dir", ".", "--workspace", "team"],
      { fake: connector },
      no,
    );
    expect(questions).toEqual(["Apply 1 change to team? [y/N] "]);
  });

  it("exits 1 on a ! line with --dry-run", async () => {
    const { connector } = liveConnector([manualChange, agentChange]);
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--dry-run"], { fake: connector }),
    ).toBe(1);
  });

  it("exits 1 for a failed change, even when nothing differs afterwards", async () => {
    const { connector } = liveConnector([agentChange], { failOn: "alpha", failGone: true });
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(1);
    expect(err).toEqual(["Failed: ~ Alpha instructions (1 line differs): refused"]);
    expect(out.join("")).not.toContain("now matches");
  });

  it("exits 1 when a change is still left after the apply", async () => {
    const { connector } = liveConnector([agentChange, contextChange], { stick: "context" });
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(1);
    expect(err).toEqual(["1 change still differs:", "  ~ Agent context"]);
  });

  it("reports each change that failed, and exits 1", async () => {
    const { connector } = liveConnector([agentChange, contextChange], { failOn: "alpha" });
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(1);
    expect(err[0]).toBe("Failed: ~ Alpha instructions (1 line differs): refused");
  });

  it("applies what it can beside a ! line, and still exits 1", async () => {
    const { connector, applied } = liveConnector([manualChange, agentChange]);
    expect(
      await cli(writeSetup(baseSetup()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(1);
    expect(applied).toEqual([[agentChange]]);
    expect(out.join("")).toContain("Applied; 1 item needs setup first (see the ! lines above).");
  });
});

/**
 * A connector for two or more targets. They share one connector object, so its live state,
 * pulls and applies are kept by target id.
 */
const targetsConnector = (
  initial: Record<string, Change[]>,
  options: { pullError?: Record<string, string> } = {},
) => {
  const pending = new Map(Object.entries(initial).map(([id, changes]) => [id, [...changes]]));
  const pulls: { target: string; options: PullOptions }[] = [];
  const applied: { target: string; changes: Change[] }[] = [];
  // `apply` gets only the changes: they go to the target pulled last, as the CLI runs one at a time.
  let current = "";
  const connector = fakeConnector({
    pull: (target, pullOptions = {}) => {
      current = target.id;
      pulls.push({ target: target.id, options: pullOptions });
      const error = options.pullError?.[target.id];
      if (error) return Promise.reject(new Error(error));
      pullOptions.log?.(`Workspace: ${target.id}`);
      return Promise.resolve({});
    },
    plan: (rendered) => Promise.resolve([...(pending.get(rendered.target.id) ?? [])]),
    apply: (changes) => {
      applied.push({ target: current, changes });
      pending.set(
        current,
        (pending.get(current) ?? []).filter((change) => change.manual || change.note),
      );
      return Promise.resolve({ failed: [] });
    },
  });
  return { connector, pulls, applied, pulled: () => pulls.map((pull) => pull.target) };
};

/** `baseSetup()` with a second target, `u`. */
const twoTargets = (): Record<string, string | null> => ({
  ...baseSetup(),
  "targets/u/target.yaml": "id: u\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta]\n",
});

const uChange: Change = { kind: "agent", id: "alpha", summary: "~ Alpha in u" };
const tChange: Change = { kind: "agent", id: "alpha", summary: "~ Alpha in t" };

describe("several targets", () => {
  it("syncs every target in slug order, past one that's up to date", async () => {
    const { connector, applied } = targetsConnector({ t: [], u: [uChange] });
    expect(
      await cli(writeSetup(twoTargets()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(0);
    expect(applied).toEqual([{ target: "u", changes: [uChange] }]);
    expect(out.join("")).toBe(
      [
        "Target t (1 of 2)",
        "Workspace: t",
        "Up to date.",
        "",
        "Target u (2 of 2)",
        "Workspace: u",
        "1 change:",
        "  ~ Alpha in u",
        "Workspace: u",
        "Applied; u now matches the setup.",
        "",
      ].join("\n"),
    );
  });

  it("asks once per target, and goes on past one that's skipped", async () => {
    const { connector, applied } = targetsConnector({ t: [tChange], u: [uChange] });
    const questions: string[] = [];
    const answers = ["n", "y"];
    const ask = (question: string) => {
      questions.push(question);
      return Promise.resolve(answers.shift() ?? "");
    };
    expect(
      await cli(writeSetup(twoTargets()), ["sync", "--dir", "."], { fake: connector }, ask),
    ).toBe(0);
    expect(questions).toEqual(["Apply 1 change to t? [y/N] ", "Apply 1 change to u? [y/N] "]);
    expect(applied).toEqual([{ target: "u", changes: [uChange] }]);
    expect(out.join("")).toContain("Skipped.");
  });

  it("goes on past a target whose platform can't be read, and exits 1", async () => {
    const { connector, applied } = targetsConnector(
      { t: [tChange], u: [uChange] },
      { pullError: { t: "no workspace t for this profile" } },
    );
    expect(
      await cli(writeSetup(twoTargets()), ["sync", "--dir", ".", "--yes"], { fake: connector }),
    ).toBe(1);
    expect(err).toEqual(["Stopped: no workspace t for this profile"]);
    expect(applied).toEqual([{ target: "u", changes: [uChange] }]);
  });

  it("goes on past a target whose connector isn't installed, and exits 1", async () => {
    const { connector, applied } = targetsConnector({ u: [uChange] });
    const dir = writeSetup({
      ...twoTargets(),
      "targets/t/target.yaml": "id: t\nconnector: gone\nworkflows: [flow]\nagents: [alpha, beta]\n",
    });
    expect(await cli(dir, ["sync", "--dir", ".", "--yes"], { fake: connector })).toBe(1);
    expect(err).toEqual(["no connector gone: install @10xagents/connector-gone"]);
    expect(applied).toEqual([{ target: "u", changes: [uChange] }]);
  });

  it("syncs every target when the config names one", async () => {
    const { connector, pulled } = targetsConnector({ t: [], u: [] });
    const dir = writeSetup({
      ...twoTargets(),
      "10xagents.config.ts": configText({ extends: [], target: "t" }),
    });
    expect(await cli(dir, ["sync", "--dir", ".", "--yes"], { fake: connector })).toBe(0);
    expect(pulled()).toEqual(["t", "u"]);
  });

  it("leaves out an extended setup's targets, unless --target names one", async () => {
    const { connector, pulled } = targetsConnector({ t: [], u: [], x: [] });
    const root = writeSetup({
      ...Object.fromEntries(
        Object.entries(twoTargets()).map(([path, text]) => [`.10xagents/${path}`, text]),
      ),
      ".10xagents/10xagents.config.ts": configText({ extends: ["../base"] }),
      "base/targets/x/target.yaml":
        "id: x\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta]\n",
    });
    expect(await cli(root, ["sync", "--yes"], { fake: connector })).toBe(0);
    expect(pulled()).toEqual(["t", "u"]);
    expect(await cli(root, ["sync", "--target", "x", "--yes"], { fake: connector })).toBe(0);
    expect(pulled()).toEqual(["t", "u", "x"]);
    expect(out.join("")).not.toContain("Target x");
  });

  it("syncs only the --target given, and passes the other flags to every target", async () => {
    const dir = writeSetup(twoTargets());
    const only = targetsConnector({ t: [tChange], u: [uChange] });
    expect(
      await cli(dir, ["sync", "--dir", ".", "--target", "u", "--yes"], { fake: only.connector }),
    ).toBe(0);
    expect(only.pulled()).toEqual(["u", "u"]);
    expect(only.applied).toEqual([{ target: "u", changes: [uChange] }]);
    expect(out.join("")).not.toContain("Target u");

    const dry = targetsConnector({ t: [tChange], u: [uChange] });
    expect(
      await cli(dir, ["sync", "--dir", ".", "--dry-run", "--profile", "p"], {
        fake: dry.connector,
      }),
    ).toBe(0);
    expect(dry.applied).toEqual([]);
    expect(dry.pulls.map(({ target, options }) => [target, options.profile])).toEqual([
      ["t", "p"],
      ["u", "p"],
    ]);
  });

  it("refuses --workspace without --target, before reading any target", async () => {
    const dir = writeSetup(twoTargets());
    const { connector, pulls } = targetsConnector({ t: [], u: [] });
    expect(await cli(dir, ["sync", "--dir", ".", "--workspace", "w"], { fake: connector })).toBe(1);
    expect(err).toEqual(["--workspace works on one target: add --target."]);
    expect(out).toEqual([]);
    expect(pulls).toEqual([]);
    expect(
      await cli(dir, ["plan", "--dir", ".", "--workspace", "w", "--target", "u"], {
        fake: connector,
      }),
    ).toBe(0);
    expect(pulls.map(({ target, options }) => [target, options.workspace])).toEqual([["u", "w"]]);
  });

  it("stops before any target when the setup doesn't load", async () => {
    const { connector, pulls } = targetsConnector({ t: [] });
    const dir = writeSetup({
      ...twoTargets(),
      "targets/u/target.yaml": "id: x\nconnector: fake\nagents: [alpha]\n",
    });
    expect(await cli(dir, ["sync", "--dir", ".", "--yes"], { fake: connector })).toBe(1);
    expect(err).toEqual(["targets/u/target.yaml: id: must match the folder name (u)", "1 error."]);
    expect(out).toEqual([]);
    expect(pulls).toEqual([]);
  });

  it("fails only the target whose own template is broken", async () => {
    const { connector, applied } = targetsConnector({ t: [tChange], u: [uChange] });
    const dir = writeSetup({
      ...twoTargets(),
      "targets/t/templates/broken.md": "---\nslots:\n  handback: {}\n---\nNo slot.\n",
    });
    expect(await cli(dir, ["sync", "--dir", ".", "--yes"], { fake: connector })).toBe(1);
    expect(err).toEqual([
      "targets/t/templates/broken.md: slots.handback: is never placed: the body has no {{slot:handback}}",
      "1 error.",
    ]);
    expect(applied).toEqual([{ target: "u", changes: [uChange] }]);
    expect(await cli(dir, ["validate", "--dir", ".", "--target", "u"])).toBe(0);
  });

  it("plans every target, and exits 1 on a ! line in any", async () => {
    const dir = writeSetup(twoTargets());
    const manual = targetsConnector({ t: [manualChange], u: [] });
    expect(await cli(dir, ["plan", "--dir", "."], { fake: manual.connector })).toBe(1);
    expect(out.join("")).toBe(
      [
        "Target t (1 of 2)",
        "Workspace: t",
        "  ! Beta: no agent with this name; create it first",
        "1 item needs setup first (see the ! lines above).",
        "",
        "Target u (2 of 2)",
        "Workspace: u",
        "Up to date.",
        "",
      ].join("\n"),
    );

    out.length = 0;
    const unread = targetsConnector({ t: [], u: [uChange] }, { pullError: { t: "offline" } });
    expect(await cli(dir, ["plan", "--dir", "."], { fake: unread.connector })).toBe(1);
    expect(err).toEqual(["Stopped: offline"]);
    expect(out.join("")).toContain("Target u (2 of 2)\nWorkspace: u\n1 change:\n  ~ Alpha in u\n");
  });

  it("logs one line per target that changed", async () => {
    const dir = writeSetup(twoTargets());
    const { connector } = targetsConnector({ t: [tChange], u: [uChange] });
    expect(await cli(dir, ["sync", "--dir", ".", "--yes"], { fake: connector })).toBe(0);
    expect(readSyncLog(dir).map((entry) => entry.target)).toEqual(["t", "u"]);
  });
});
