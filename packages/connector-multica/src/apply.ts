// Makes the changes `plan` found, with the same `multica` calls `.multica/sync.mjs` made.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplyResult, Change } from "10xagents";

import type { MulticaCli } from "./multica.ts";
import { run, runJson } from "./multica.ts";
import type { ChangeData } from "./plan.ts";
import { toStep } from "./pull.ts";
import { zipSkill } from "./skills.ts";
import { customKeys, stepsFor } from "./steps.ts";

const OPS = new Set([
  "skill-import",
  "agent-update",
  "agent-skills-add",
  "squad-instructions",
  "squad-member-add",
  "squad-member-role",
  "squad-leader",
  "workflow",
  "context",
]);

const isData = (value: unknown): value is ChangeData =>
  !!value &&
  typeof value === "object" &&
  "op" in value &&
  typeof value.op === "string" &&
  OPS.has(value.op) &&
  "cli" in value &&
  "workspace" in value;

/** Makes `changes` in order. One that fails, like a skill another account owns, leaves the rest. */
export const applyChanges = (changes: readonly Change[]): ApplyResult => {
  const failed: ApplyResult["failed"] = [];
  const dir = mkdtempSync(join(tmpdir(), "10xagents-multica-"));
  // The Agent context describes the workflow, so it doesn't go in when the workflow's write fails.
  let workflowFailed = false;
  try {
    let files = 0;
    const file = (name: string, content: string | Buffer) => {
      const path = join(dir, `${++files}-${name}`);
      writeFileSync(path, content);
      return path;
    };
    for (const change of changes) {
      if (change.manual || change.note) continue;
      try {
        if (!isData(change.data)) throw new Error("not a change the Multica connector planned");
        const data = change.data;
        if (data.op === "workflow") {
          try {
            writeWorkflow(data.cli, data.workspace, data, file);
          } catch (error) {
            workflowFailed = true;
            throw error;
          }
        } else if (data.op === "context") {
          if (workflowFailed) throw new Error("held back, since the workflow's write failed");
          run(
            data.cli,
            ["workspace", "update", data.workspace, "--context-stdin"],
            data.workspace,
            data.context,
          );
        } else applyOne(data, file);
      } catch (error) {
        failed.push({ change, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { failed };
};

const applyOne = (data: ChangeData, file: (name: string, content: string | Buffer) => string) => {
  const { cli, workspace } = data;
  const call = (args: string[]) => run(cli, args, workspace);
  switch (data.op) {
    case "skill-import":
      call([
        "skill",
        "import",
        "--file",
        file(`${data.skill.name}.zip`, zipSkill(data.skill)),
        "--on-conflict",
        "overwrite",
      ]);
      return;
    case "agent-update":
      call(["agent", "update", data.agent, ...data.args]);
      return;
    case "agent-skills-add": {
      // A skill this sync just imported has an id only now.
      const listed = runJson(cli, ["skill", "list"], workspace);
      const matched = (Array.isArray(listed) ? listed : [])
        .filter(
          (skill): skill is { id: unknown; name: unknown } =>
            !!skill && typeof skill === "object" && "name" in skill && "id" in skill,
        )
        .filter((skill) => data.skills.includes(String(skill.name)));
      // Attach what's there, as sync.mjs did, and report the rest.
      if (matched.length > 0) {
        const ids = matched.map((skill) => String(skill.id));
        call(["agent", "skills", "add", data.agent, "--skill-ids", ids.join(",")]);
      }
      const found = new Set(matched.map((skill) => String(skill.name)));
      const missing = data.skills.filter((name) => !found.has(name));
      if (missing.length > 0) {
        throw new Error(`not in the workspace, so not attached: ${missing.join(", ")}`);
      }
      return;
    }
    case "squad-instructions":
      call(["squad", "update", data.squad, "--instructions", data.instructions]);
      return;
    case "squad-member-add":
      call([
        "squad",
        "member",
        "add",
        data.squad,
        "--member-id",
        data.agent,
        "--type",
        "agent",
        "--role",
        data.role,
      ]);
      return;
    case "squad-member-role":
      call([
        "squad",
        "member",
        "set-role",
        data.squad,
        "--member-id",
        data.agent,
        "--member-type",
        "agent",
        "--role",
        data.role,
      ]);
      return;
    case "squad-leader":
      call(["squad", "update", data.squad, "--leader", data.agent]);
      return;
    default:
      throw new Error(`can't apply ${data.op} here`);
  }
};

/**
 * Writes the workflow in two passes. The first names every custom column, so Multica creates or
 * reuses its status, and sets only the moves whose target has a key. The second sets the moves
 * to custom columns, with the keys the first one made.
 */
const writeWorkflow = (
  cli: MulticaCli,
  workspace: string,
  data: Extract<ChangeData, { op: "workflow" }>,
  file: (name: string, content: string) => string,
) => {
  const steps = (keys: ReadonlyMap<number, string>) =>
    file("steps.json", JSON.stringify(stepsFor(data.specs, keys), null, 2));
  const first = stepsFor(data.specs, new Map());
  const written = runJson(
    cli,
    ["workflow", "update", data.workflow, "--steps-file", steps(new Map())],
    workspace,
  );
  const writtenSteps =
    written && typeof written === "object" && "steps" in written && Array.isArray(written.steps)
      ? written.steps
          .filter((step): step is Record<string, unknown> => !!step && typeof step === "object")
          .map(toStep)
      : [];
  const made = customKeys(
    writtenSteps.map((step) => step.status_key),
    data.specs,
  );
  const custom = data.specs.filter((spec) => !spec.key).length;
  if (made.size !== custom) {
    throw new Error("the written workflow's custom columns don't line up with the setup's");
  }
  const second = stepsFor(data.specs, made);
  if (JSON.stringify(second) !== JSON.stringify(first)) {
    run(cli, ["workflow", "update", data.workflow, "--steps-file", steps(made)], workspace);
  }
};
