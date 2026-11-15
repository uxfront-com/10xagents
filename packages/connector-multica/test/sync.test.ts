import { chmodSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { childEnv, createConnector, findMultica, validate } from "../src/index.ts";
import {
  baseFiles,
  fake,
  freshState,
  planWith,
  render,
  summaries,
  syncWith,
  toApply,
  writeFiles,
  tempDir,
} from "./helpers.ts";

describe("a first sync", () => {
  it("writes skills, agents, the squad, the workflow and the Agent context, then matches", async () => {
    const rendered = render();
    const multica = fake();
    const { changes, failed } = await syncWith(rendered, multica.env);
    expect(failed).toEqual([]);
    expect(summaries(toApply(changes))).toEqual([
      "+ extra (new)",
      "+ workspace (new)",
      "~ Alpha instructions (8 lines differ), description:  → Alpha does the work., model:  → test-model, thinking-level:  → high, max-concurrent-tasks: 1 → 2",
      "+ Alpha skills: workspace, extra",
      "~ Beta instructions (8 lines differ), description:  → Beta does the work., model:  → test-model, thinking-level:  → high, max-concurrent-tasks: 1 → 2",
      "+ Beta skills: workspace",
      "~ Crew instructions (1 line differs)",
      "+ Alpha joins Crew",
      "+ Beta joins Crew",
      "~ leader → Alpha",
      "~ Default workflow: + Planning, + Plan Approval, - in_review, Todo handoff, Todo moves, Blocked handoff",
      "~ Agent context (1 line differs)",
    ]);

    const state = multica.state();
    expect(state.workspace.context).toBe("Ask Sam when stuck.");
    expect(state.skills.map((skill) => skill.name).toSorted()).toEqual(["extra", "workspace"]);
    expect(state.skills.find((skill) => skill.name === "workspace")?.files).toEqual([
      { path: "repos/rules.md", content: "Rules.\n" },
    ]);
    const alpha = state.agents.find((agent) => agent.name === "Alpha");
    expect(alpha?.instructions).toBe(rendered.agents[0]?.instructions);
    expect(alpha?.skills.map((skill) => skill.name).toSorted()).toEqual(["extra", "workspace"]);
    const squad = state.squads[0];
    expect(squad?.instructions).toBe("Work together.");
    expect(squad?.leader_id).toBe("ag-alpha");
    expect(squad?.members).toEqual([
      { member_id: "ag-alpha", member_type: "agent", role: "member" },
      { member_id: "ag-beta", member_type: "agent", role: "Reviews the work." },
    ]);

    // Then nothing is left to apply: only the notes.
    const again = await planWith(rendered, multica.env);
    expect(toApply(again.changes)).toEqual([]);
    expect(again.changes.filter((change) => change.manual)).toEqual([]);
  });

  it("writes the workflow in two passes, and maps custom keys back by place", async () => {
    const rendered = render();
    const multica = fake();
    await syncWith(rendered, multica.env);
    const updates = multica
      .calls()
      .filter((call) => call.args.slice(0, 2).join(" ") === "workflow update");
    expect(updates).toHaveLength(2);
    const steps = multica.state().workflows[0]?.steps ?? [];
    expect(steps.map((step) => step.status_key)).toEqual([
      "backlog",
      "todo",
      "planning",
      "plan_approval",
      "in_progress",
      "blocked",
      "done",
      "cancelled",
    ]);
    expect(steps[1]).toMatchObject({
      handler: { type: "agent", id: "ag-alpha" },
      instructions: "Triage it, then move it to Planning.",
      next_status_key: "planning",
    });
    expect(steps[2]).toMatchObject({
      handler: { type: "agent", id: "ag-beta" },
      next_status_key: "plan_approval",
      back_status_key: "todo",
    });
    expect(steps[3]).toMatchObject({
      handler: { type: "member", id: "u-1" },
      next_status_key: "in_progress",
    });
    expect(steps[4]).toMatchObject({ handler: null });
  });

  it("maps keys by place, so a status the server named another way still lines up", async () => {
    const rendered = render();
    const multica = fake();
    multica.set((state) => {
      state.statuses = [{ key: "custom_1", name: "Planning", category: "started" }];
    });
    await syncWith(rendered, multica.env);
    const again = await planWith(rendered, multica.env);
    expect(toApply(again.changes)).toEqual([]);
    const steps = multica.state().workflows[0]?.steps ?? [];
    expect(steps[1]).toMatchObject({ next_status_key: "custom_1" });
  });
});

describe("the multica child process", () => {
  it("gets no inherited MULTICA_* variable, and runs in $HOME", async () => {
    const multica = fake();
    await syncWith(render(), multica.env);
    const calls = multica.calls();
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      expect(call.cwd).toBe(multica.home);
      for (const key of Object.keys(call.env)) expect(key).toBe("MULTICA_WORKSPACE_ID");
      if (call.env.MULTICA_WORKSPACE_ID !== undefined)
        expect(call.env.MULTICA_WORKSPACE_ID).toBe("ws-1");
    }
    // Workspace calls run inside the workspace, the rest outside any.
    expect(calls.find((call) => call.args[0] === "agent")?.env).toEqual({
      MULTICA_WORKSPACE_ID: "ws-1",
    });
    expect(calls.find((call) => call.args.join(" ") === "workspace list")?.env).toEqual({});
  });

  it("keeps every other variable", () => {
    expect(
      childEnv(
        { PATH: "/bin", HOME: "/h", MULTICA_TOKEN: "x", MULTICA_TASK_ID: "y", MULTICAX: "z" },
        "ws",
      ),
    ).toEqual({ PATH: "/bin", HOME: "/h", MULTICAX: "z", MULTICA_WORKSPACE_ID: "ws" });
  });

  it("finds the CLI from $MULTICA, then $MULTICA_CLI_PATH, then PATH, then the Desktop app", () => {
    const bin = writeFiles(tempDir(), { multica: "#!/bin/sh\n" });
    const desktop = writeFiles(tempDir(), { multica: "" });
    chmodSync(`${bin}/multica`, 0o755);
    expect(findMultica({ MULTICA: "/a", MULTICA_CLI_PATH: "/b", PATH: bin }, "/d")).toBe("/a");
    expect(findMultica({ MULTICA_CLI_PATH: "/b", PATH: bin }, "/d")).toBe("/b");
    expect(findMultica({ PATH: `/nowhere:${bin}` }, "/d")).toBe(`${bin}/multica`);
    expect(findMultica({ PATH: "/nowhere" }, `${desktop}/multica`)).toBe(`${desktop}/multica`);
    expect(() => findMultica({ PATH: "/nowhere" }, "/nowhere/multica")).toThrow(
      /multica CLI not found/,
    );
  });
});

describe("profiles", () => {
  it("stops with several profiles and no terminal, and names --profile", async () => {
    const multica = fake(freshState(), ["p1", "p2"]);
    await expect(planWith(render(), multica.env, null)).rejects.toThrow(
      "several Multica profiles: pass --profile <name> (p1, p2)",
    );
    expect(multica.calls()).toEqual([]);
  });

  it("uses the profile --profile picks", async () => {
    const multica = fake({ ...freshState(), profile: "p2" }, ["p1", "p2"]);
    const { live } = await planWith(render(), multica.env, "p2");
    expect(live.profile).toBe("p2");
    expect(new Set(multica.calls().map((call) => call.profile))).toEqual(new Set(["p2"]));
  });

  it("asks for the profile once, and its place reads the same profile and workspace again", async () => {
    const multica = fake({ ...freshState(), profile: "p2" }, ["p1", "p2"]);
    const connector = createConnector({ env: multica.env, desktop: "/nowhere/multica" });
    const questions: string[] = [];
    const ask = (question: string) => {
      questions.push(question);
      return Promise.resolve("2");
    };
    const rendered = render();
    const live = await connector.pull(rendered.target, { ask });
    const place = connector.place?.(live);
    expect(place).toEqual({ name: "Team", pull: { profile: "p2", workspace: "ws-1" } });
    await connector.pull(rendered.target, { ...place?.pull, ask });
    expect(questions).toEqual(["  1. p1\n  2. p2\nProfile (number): "]);
    expect(new Set(multica.calls().map((call) => call.profile))).toEqual(new Set(["p2"]));
  });

  it("uses the only profile there is", async () => {
    const multica = fake();
    const { live } = await planWith(render(), multica.env, null);
    expect(live.profile).toBe("p1");
  });

  it("uses the default profile with no --profile flag", async () => {
    const multica = fake({ ...freshState(), profile: "" }, []);
    writeFiles(multica.home, { ".multica/config.json": JSON.stringify({ token: "t" }) });
    const { live } = await planWith(render(), multica.env, null);
    expect(live.profile).toBe("");
    expect(multica.calls()[0]?.args).toEqual(["workspace", "list"]);
    expect(multica.calls()[0]?.profile).toBe("");
  });

  it("names the call that failed, and what multica said", async () => {
    const multica = fake({ ...freshState(), profile: "p2" }, ["p1", "p2"]);
    await expect(planWith(render(), multica.env, "p1")).rejects.toThrow(
      "multica workspace list: No server configured",
    );
  });

  it("stops when the workspace isn't the profile's", async () => {
    const multica = fake();
    const rendered = render();
    await expect(
      planWith(
        { ...rendered, target: { ...rendered.target, workspace: "elsewhere" } },
        multica.env,
      ),
    ).rejects.toThrow("no workspace elsewhere for this profile");
  });
});

describe("skills", () => {
  it("adds missing skills and never removes one attached by hand", async () => {
    const multica = fake();
    multica.set((state) => {
      state.skills.push({ id: "sk-mine", name: "mine", content: "x", files: [] });
      state.agents[0]?.skills.push({ id: "sk-mine", name: "mine", enabled: true });
    });
    await syncWith(render(), multica.env);
    expect(
      multica
        .state()
        .agents[0]?.skills.map((skill) => skill.name)
        .toSorted(),
    ).toEqual(["extra", "mine", "workspace"]);
    expect(multica.writes().filter((line) => line.startsWith("agent skills"))).toHaveLength(2);
    expect(multica.writes().some((line) => /remove|delete/.test(line))).toBe(false);
  });

  it("attaches the skills that are there when another fails to import", async () => {
    const multica = fake();
    multica.set((state) => {
      state.skills.push({
        id: "sk-ws",
        name: "workspace",
        content: "---\nname: workspace\n---\n\nThe workspace.\n",
        files: [{ path: "repos/rules.md", content: "Rules.\n" }],
      });
      state.fail = { "skill import": "owned by another account" };
    });
    const { failed } = await syncWith(render(), multica.env);
    expect(failed.map(({ change, message }) => `${change.summary}: ${message}`)).toEqual([
      "+ extra (new): multica skill import --file: owned by another account",
      "+ Alpha skills: workspace, extra: not in the workspace, so not attached: extra",
    ]);
    expect(multica.state().agents[0]?.skills.map((skill) => skill.name)).toEqual(["workspace"]);
  });

  it("prints ! for a skill that's attached but disabled", async () => {
    const multica = fake();
    await syncWith(render(), multica.env);
    multica.set((state) => {
      const skill = state.agents[1]?.skills[0];
      if (skill) skill.enabled = false;
    });
    const { changes } = await planWith(render(), multica.env);
    expect(changes.filter((change) => change.manual).map((change) => change.summary)).toEqual([
      "! Beta: workspace is attached but disabled; switch it on in the agent's Skills tab",
    ]);
  });

  it("re-imports a skill whose files differ, and lists what differs", async () => {
    const multica = fake();
    await syncWith(render(), multica.env);
    const files = {
      ...baseFiles(),
      "skills/workspace/repos/rules.md": "New rules.\n",
      "skills/workspace/more.md": "More.\n",
    };
    const { changes } = await planWith(render(files), multica.env);
    const change = toApply(changes)[0];
    expect(change?.summary).toBe("~ workspace: + more.md, ~ repos/rules.md (1 line differs)");
    expect(change?.diff).toContain("-Rules.\n+New rules.");
  });

  it("fails validate for a skill whose name isn't its folder's, or a file the import drops", () => {
    const files = {
      ...baseFiles(),
      "skills/workspace/SKILL.md": "---\nname: work-space\n---\n\nThe workspace.\n",
      "skills/workspace/.hidden": "x",
      "skills/workspace/LICENSE": "x",
    };
    const messages = validate(render(files)).map(
      (issue) => `${issue.file?.split("/skills/")[1]}: ${issue.field}: ${issue.message}`,
    );
    expect(messages).toEqual([
      "workspace/SKILL.md: name: must be workspace, like its folder (it says work-space): Multica names a skill after it",
      "workspace/.hidden: (file): Multica leaves this file out of an import: rename or remove it",
      "workspace/LICENSE: (file): Multica leaves this file out of an import: rename or remove it",
    ]);
  });
});

describe("what only a person can do", () => {
  it("prints ! for an agent or a squad that doesn't exist", async () => {
    const multica = fake();
    multica.set((state) => {
      state.agents = state.agents.filter((agent) => agent.name !== "Beta");
      state.squads = [];
    });
    const { changes } = await planWith(render(), multica.env);
    expect(changes.filter((change) => change.manual).map((change) => change.summary)).toEqual([
      "! Beta: no agent with this name; create it first",
      "! no squad named Crew; create it first",
      "! Agent: Beta: no agent with this name; create it first",
    ]);
    // The workflow and the context wait for the agent.
    expect(toApply(changes).some((change) => change.kind === "workflow")).toBe(false);
    expect(summaries(changes)).toContain(
      "· Agent context (1 line differs): waits for the workflow",
    );
  });

  it("holds back the workflow and the context when owner resolves to no member", async () => {
    const files = {
      ...baseFiles(),
      "targets/t/target.yaml":
        baseFiles()["targets/t/target.yaml"]?.replace("owner: Sam", "owner: Nobody") ?? null,
    };
    const multica = fake();
    const { changes, failed } = await syncWith(render(files), multica.env);
    expect(failed).toEqual([]);
    expect(changes.filter((change) => change.manual).map((change) => change.summary)).toEqual([
      "! owner: Nobody: no workspace member has this name",
    ]);
    expect(
      multica
        .writes()
        .filter((line) => line.startsWith("workflow") || line.startsWith("workspace update")),
    ).toEqual([]);
    expect(multica.state().workspace.context).toBe("");
  });

  it("holds back the workflow when owner matches two members by first name", async () => {
    const multica = fake();
    multica.set((state) => {
      state.members.push({ user_id: "u-3", name: "Sam Jones" });
    });
    const { changes } = await planWith(render(), multica.env);
    expect(changes.filter((change) => change.manual).map((change) => change.summary)).toEqual([
      "! owner: Sam matches Sam Smith and Sam Jones: write the full name in vars.owner",
    ]);
  });

  it("resolves owner by full name first", async () => {
    const multica = fake();
    multica.set((state) => {
      state.members.push({ user_id: "u-3", name: "Sam" });
    });
    const { changes } = await planWith(render(), multica.env);
    expect(summaries(changes)).toContain("· owner: Sam is Sam");
  });

  it("prints ! when the CLI has no workflow command", async () => {
    const multica = fake();
    multica.set((state) => {
      state.noWorkflowCommand = true;
    });
    const { changes } = await planWith(render(), multica.env);
    expect(changes.filter((change) => change.manual).map((change) => change.summary)).toEqual([
      "! this multica CLI has no `workflow` command: update it, or build the workflow by hand",
    ]);
  });
});

describe("the Agent context", () => {
  it("is held back when the workflow's write fails", async () => {
    const multica = fake();
    multica.set((state) => {
      state.fail = { "workflow update": "the server refused it" };
    });
    const { failed } = await syncWith(render(), multica.env);
    expect(failed.map(({ change, message }) => `${change.summary}: ${message}`)).toEqual([
      "~ Default workflow: + Planning, + Plan Approval, - in_review, Todo handoff, Todo moves, Blocked handoff: multica workflow update wf-1: the server refused it",
      "~ Agent context (1 line differs): held back, since the workflow's write failed",
    ]);
    expect(multica.state().workspace.context).toBe("");
    // Everything else still went in.
    expect(multica.state().squads[0]?.leader_id).toBe("ag-alpha");
  });

  it("is left alone when the setup gives none", async () => {
    const files = { ...baseFiles(), "traits/global/01-rules.md": null };
    const multica = fake();
    multica.set((state) => {
      state.workspace.context = "Written by hand.";
    });
    const { changes } = await syncWith(render(files), multica.env);
    expect(summaries(changes)).toContain(
      "· the setup gives this workspace no Agent context: left alone",
    );
    expect(multica.state().workspace.context).toBe("Written by hand.");
  });
});

describe("projects", () => {
  it("lists a project on another workflow with the command to switch it back, and never switches it", async () => {
    const multica = fake();
    const { changes } = await syncWith(render(), multica.env);
    expect(
      changes
        .filter((change) => change.note && change.kind === "project")
        .map((change) => change.summary),
    ).toEqual([
      "· Side: on another workflow; switch it back with `multica --profile p1 --workspace-id ws-1 project workflow set p-2 default`",
    ]);
    expect(multica.writes().some((line) => line.startsWith("project"))).toBe(false);
    expect(multica.state().workflows[0]?.project_ids).toEqual(["p-1"]);
  });
});
