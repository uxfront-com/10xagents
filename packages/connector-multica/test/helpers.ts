// A setup on disk, rendered for Multica, and a fake `multica` with a workspace's state.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Diagnostics, formatDiagnostic, loadSetup, renderTarget, validateSetup } from "10xagents";
import type { Change, LiveState, RenderedSetup } from "10xagents";
import { afterEach } from "vitest";

import { columnNames, createConnector, validate } from "../src/index.ts";
import type { MulticaLive } from "../src/index.ts";

export const FAKE = join(import.meta.dirname, "fake-multica.mjs");
chmodSync(FAKE, 0o755);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test, with its real path. */
export const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "10xagents-multica-")));
  made.push(dir);
  return dir;
};

export type Files = Record<string, string | null>;

export const writeFiles = (dir: string, files: Files): string => {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
};

const agentYaml = (id: string, name: string, skills: string, role?: string): string =>
  [
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} does the work.`,
    "model: { id: test-model, thinking: high }",
    "concurrency: 2",
    `skills: [${skills}]`,
    ...(role ? [`squad: { role: ${role} }`] : []),
    "sections:",
    `  role: You're the ${name}.`,
    "  handback: The result.",
    "",
  ].join("\n");

/** One target, `t`, on one workflow, with two agents, two skills, a squad and a global trait. */
export const baseFiles = (): Files => ({
  "agents/alpha.yaml": agentYaml("alpha", "Alpha", "workspace, extra, not-here"),
  "agents/beta.yaml": agentYaml("beta", "Beta", "workspace", "Reviews the work."),
  "skills/workspace/SKILL.md": "---\nname: workspace\n---\n\nThe workspace.\n",
  "skills/workspace/repos/rules.md": "Rules.\n",
  "targets/t/skills/extra/SKILL.md": "---\nname: extra\n---\n\nExtra.\n",
  "traits/global/01-rules.md": "Ask {{vars.owner}} when stuck.\n",
  "squad.md": "Work together.\n",
  "workflows/request/workflow.yaml": [
    "id: request",
    "entry: todo",
    "columns:",
    "  - { key: backlog, handoff: none }",
    '  - { key: todo, handoff: "agent:alpha", next: planning }',
    '  - { key: planning, name: Planning, handoff: "agent:beta", next: plan_approval, back: todo }',
    "  - { key: plan_approval, name: Plan Approval, handoff: owner, next: in_progress }",
    "  - { key: in_progress, handoff: none }",
    "  - { key: blocked, handoff: owner }",
    "  - { key: done, handoff: none }",
    "  - { key: cancelled, handoff: none }",
    "",
  ].join("\n"),
  "workflows/request/steps/todo.md":
    "Triage it, then move it to {{workflows.request.columns.planning}}.\n",
  "workflows/request/steps/planning.md":
    "Plan it, then move it to {{workflows.request.columns.plan_approval}}.\n",
  "targets/t/target.yaml": [
    "id: t",
    "workspace: team",
    "connector: multica",
    "workflows: [request]",
    "agents: [alpha, beta]",
    "vars: { owner: Sam }",
    "squad: { name: Crew, leader: alpha }",
    "",
  ].join("\n"),
});

/** Writes `files` to a fresh directory and renders target `t` for Multica. Throws on errors. */
export const render = (files: Files = baseFiles(), slug = "t"): RenderedSetup => {
  const dir = writeFiles(tempDir(), files);
  const diagnostics = new Diagnostics();
  const setup = loadSetup(dir, diagnostics);
  validateSetup(setup, diagnostics, { target: slug });
  const rendered = renderTarget(setup, slug, diagnostics, { sharedContext: true, columnNames });
  const errors = diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, dir));
  if (errors.length > 0 || !rendered) throw new Error(`expected no errors:\n${errors.join("\n")}`);
  return rendered;
};

/** The connector's own errors for a rendered setup, as `<field>: <message>`. */
export const issuesOf = (rendered: RenderedSetup): string[] =>
  validate(rendered).map((issue) => `${issue.field}: ${issue.message}`);

const BUILT_IN_STEPS = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
].map((status_key) => ({
  status_key,
  handler: null,
  instructions: "",
  next_status_key: null,
  back_status_key: null,
}));

export interface Call {
  args: string[];
  profile: string;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

export interface FakeState {
  profile?: string;
  workspace: { id: string; name: string; slug: string; context: string };
  members: { user_id: string; name: string; email?: string }[];
  skills: {
    id: string;
    name: string;
    content: string;
    files: { path: string; content: string }[];
  }[];
  agents: {
    id: string;
    name: string;
    description: string;
    model: string;
    thinking_level: string;
    max_concurrent_tasks: number;
    instructions: string;
    skills: { id: string; name: string; enabled: boolean }[];
  }[];
  squads: {
    id: string;
    name: string;
    instructions: string;
    leader_id: string;
    members: { member_id: string; member_type: string; role: string }[];
  }[];
  workflows: {
    id: string;
    is_default: boolean;
    steps: Record<string, unknown>[];
    project_ids: string[];
  }[];
  projects: { id: string; title: string }[];
  statuses?: { key: string; name: string; category: string }[];
  fail?: Record<string, string>;
  noWorkflowCommand?: boolean;
  calls: Call[];
}

const blankAgent = (id: string, name: string) => ({
  id,
  name,
  description: "",
  model: "",
  thinking_level: "",
  max_concurrent_tasks: 1,
  instructions: "",
  skills: [],
});

/** A workspace with the two agents and the squad, and nothing synced yet. */
export const freshState = (): FakeState => ({
  profile: "p1",
  workspace: { id: "ws-1", name: "Team", slug: "team", context: "" },
  members: [
    { user_id: "u-1", name: "Sam Smith", email: "sam@example.com" },
    { user_id: "u-2", name: "Robin Lee" },
  ],
  skills: [],
  agents: [blankAgent("ag-alpha", "Alpha"), blankAgent("ag-beta", "Beta")],
  squads: [{ id: "sq-1", name: "Crew", instructions: "", leader_id: "", members: [] }],
  workflows: [{ id: "wf-1", is_default: true, steps: BUILT_IN_STEPS, project_ids: ["p-1"] }],
  projects: [
    { id: "p-1", title: "Main" },
    { id: "p-2", title: "Side" },
  ],
  calls: [],
});

export interface Fake {
  /** The environment the connector reads, with variables a run would leak. */
  env: Record<string, string>;
  home: string;
  state: () => FakeState;
  set: (change: (state: FakeState) => void) => void;
  calls: () => Call[];
  /** The calls that write, by their first words. */
  writes: () => string[];
}

const READS =
  /^(workspace (list|get|member list)|skill (list|get)|agent (list|get)|squad (list|get|member list)|workflow (list|get)|project list)\b/;

/** A fake Multica with `state`, a home with the profiles named, and an environment that leaks. */
export const fake = (state: FakeState = freshState(), profiles: string[] = ["p1"]): Fake => {
  const home = tempDir();
  for (const name of profiles) {
    writeFiles(home, { [`.multica/profiles/${name}/config.json`]: JSON.stringify({ token: "t" }) });
  }
  const file = join(home, "state.json");
  writeFileSync(file, JSON.stringify(state));
  const read = (): FakeState => {
    const parsed: FakeState = JSON.parse(readFileSync(file, "utf8"));
    return parsed;
  };
  return {
    home,
    env: {
      MULTICA: FAKE,
      PATH: process.env.PATH ?? "",
      HOME: home,
      FAKE_MULTICA_STATE: file,
      MULTICA_TOKEN: "run-token",
      MULTICA_SERVER_URL: "http://run.invalid",
      MULTICA_TASK_ID: "task-1",
      MULTICA_WORKSPACE_ID: "ws-other",
    },
    state: read,
    set: (change) => {
      const next = read();
      change(next);
      writeFileSync(file, JSON.stringify(next));
    },
    calls: () => read().calls,
    writes: () =>
      read()
        .calls.map((call) => call.args.join(" "))
        .filter((line) => !READS.test(line)),
  };
};

const isMulticaLive = (live: LiveState): live is MulticaLive => live.connector === "multica";

/** Pulls and plans with the fake. */
export const planWith = async (
  rendered: RenderedSetup,
  env: Record<string, string>,
  /** The `--profile` given, or `null` for none. */
  profile: string | null = "p1",
): Promise<{ live: MulticaLive; changes: Change[] }> => {
  const connector = createConnector({ env, desktop: "/nowhere/multica" });
  const live = await connector.pull(rendered.target, profile === null ? {} : { profile });
  if (!isMulticaLive(live)) throw new Error("pull returned another connector's state");
  return { live, changes: await connector.plan(rendered, live) };
};

/** Pulls, plans and applies with the fake. */
export const syncWith = async (rendered: RenderedSetup, env: Record<string, string>) => {
  const connector = createConnector({ env, desktop: "/nowhere/multica" });
  const { changes } = await planWith(rendered, env);
  const result = await connector.apply(changes.filter((change) => !change.manual && !change.note));
  return { changes, failed: result?.failed ?? [] };
};

export const toApply = (changes: readonly Change[]): Change[] =>
  changes.filter((change) => !change.manual && !change.note);
export const summaries = (changes: readonly Change[]): string[] =>
  changes.map((change) => change.summary);
