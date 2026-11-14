// Compares a rendered setup with a workspace's live state, as `.multica/sync.mjs` did: only
// what differs becomes a change, and what only a person can set up becomes a `manual` one.

import type { Change, RenderedSetup, RenderedSkill } from "10xagents";

import type { LiveAgent, LiveMember, MulticaLive } from "./pull.ts";
import { skillFiles } from "./skills.ts";
import type { Handler, StepSpec } from "./steps.ts";
import { customKeys, keyAt, stepsFor } from "./steps.ts";
import { differ, norm, preview, textDiff } from "./text.ts";
import { mergeWorkflows } from "./workflow.ts";

/** What `apply` does for one change. Every one carries the CLI and the workspace it's for. */
export type Operation =
  | { op: "skill-import"; skill: RenderedSkill }
  | { op: "agent-update"; agent: string; args: string[] }
  | { op: "agent-skills-add"; agent: string; skills: string[] }
  | { op: "squad-instructions"; squad: string; instructions: string }
  | { op: "squad-member-add"; squad: string; agent: string; role: string }
  | { op: "squad-member-role"; squad: string; agent: string; role: string }
  | { op: "squad-leader"; squad: string; agent: string }
  | { op: "workflow"; workflow: string; specs: StepSpec[] }
  | { op: "context"; context: string };

export type ChangeData = Operation & { cli: MulticaLive["cli"]; workspace: string };

/** The agent fields `agent update` sets, with their flags. */
const SETTINGS = [
  ["description", "description"],
  ["model", "model"],
  ["thinking_level", "thinking-level"],
  ["max_concurrent_tasks", "max-concurrent-tasks"],
] as const;

const memberName = (member: LiveMember): string => member.name.toLowerCase();

/** Every change that makes `live` match `rendered`, in the order `apply` makes them. */
export const planChanges = (rendered: RenderedSetup, live: MulticaLive): Change[] => {
  const changes: Change[] = [];
  const data = (operation: Operation): ChangeData => ({
    ...operation,
    cli: live.cli,
    workspace: live.workspace.id,
  });
  const change = (kind: string, id: string, summary: string, operation: Operation, diff = "") =>
    changes.push({ kind, id, summary, ...(diff ? { diff } : {}), data: data(operation) });
  const manual = (kind: string, id: string, summary: string) =>
    changes.push({ kind, id, summary: `! ${summary}`, manual: true });
  const note = (kind: string, id: string, summary: string) =>
    changes.push({ kind, id, summary: `· ${summary}`, note: true });

  // Skills: imported whole when any file differs, since an import replaces the skill.
  for (const skill of rendered.skills) {
    const files = skillFiles(skill);
    const found = live.skills.find((candidate) => candidate.name === skill.name);
    if (!found) {
      change("skill", skill.name, `+ ${skill.name} (new)`, { op: "skill-import", skill });
      continue;
    }
    const notes: string[] = [];
    let diffs = "";
    for (const [path, text] of files) {
      const have = found.files[path];
      if (have === undefined) {
        notes.push(`+ ${path}`);
        continue;
      }
      const { lines, diff } = textDiff(norm(have), text);
      if (lines) {
        notes.push(`~ ${path} (${differ(lines)})`);
        diffs += `--- ${path}\n${diff}\n`;
      }
    }
    for (const path of Object.keys(found.files)) {
      if (!files.has(path)) notes.push(`- ${path}`);
    }
    if (notes.length > 0) {
      change(
        "skill",
        skill.name,
        `~ ${skill.name}: ${notes.join(", ")}`,
        {
          op: "skill-import",
          skill,
        },
        diffs,
      );
    }
  }

  // Agents, matched by name.
  const skillNames = new Set(rendered.skills.map((skill) => skill.name));
  const liveById = new Map<string, LiveAgent>();
  for (const agent of rendered.agents) {
    const found = live.agents.find((candidate) => candidate.name === agent.name);
    if (!found) {
      manual("agent", agent.id, `${agent.name}: no agent with this name; create it first`);
      continue;
    }
    liveById.set(agent.id, found);
    const args: string[] = [];
    const notes: string[] = [];
    const { lines, diff } = textDiff(norm(found.instructions), norm(agent.instructions));
    if (lines) {
      args.push("--instructions", agent.instructions.replace(/\n+$/, ""));
      notes.push(`instructions (${differ(lines)})`);
    }
    const want: Record<(typeof SETTINGS)[number][0], string> = {
      description: agent.description,
      model: agent.model.id,
      thinking_level: agent.model.thinking,
      max_concurrent_tasks: String(agent.concurrency),
    };
    for (const [key, flag] of SETTINGS) {
      const have = found[key];
      if (want[key] && have !== want[key]) {
        args.push(`--${flag}`, want[key]);
        notes.push(`${flag}: ${preview(have)} → ${preview(want[key])}`);
      }
    }
    if (args.length > 0) {
      change(
        "agent",
        agent.id,
        `~ ${agent.name} ${notes.join(", ")}`,
        {
          op: "agent-update",
          agent: found.id,
          args,
        },
        diff,
      );
    }
    // Skills are only ever added: a skill attached by hand stays.
    const wanted = [...new Set(agent.skills)].filter((name) => skillNames.has(name));
    const missing = wanted.filter((name) => !found.skills.some((skill) => skill.name === name));
    // Runs load only enabled skills, and adding a disabled one again changes nothing: only the
    // agent's Skills tab switches it back on.
    for (const name of wanted) {
      if (found.skills.some((skill) => skill.name === name && !skill.enabled)) {
        manual(
          "agent",
          agent.id,
          `${agent.name}: ${name} is attached but disabled; switch it on in the agent's Skills tab`,
        );
      }
    }
    if (missing.length > 0) {
      change("agent", agent.id, `+ ${agent.name} skills: ${missing.join(", ")}`, {
        op: "agent-skills-add",
        agent: found.id,
        skills: missing,
      });
    }
  }

  // The squad: its instructions, members, roles and leader.
  if (rendered.squad) {
    const squad = rendered.squad;
    const found = live.squad;
    if (!found) manual("squad", squad.name, `no squad named ${squad.name}; create it first`);
    else {
      const { lines, diff } = textDiff(norm(found.instructions), norm(squad.instructions));
      if (lines) {
        change(
          "squad",
          squad.name,
          `~ ${squad.name} instructions (${differ(lines)})`,
          {
            op: "squad-instructions",
            squad: found.id,
            instructions: squad.instructions.replace(/\n+$/, ""),
          },
          diff,
        );
      }
      for (const agent of rendered.agents) {
        const liveAgent = liveById.get(agent.id);
        if (!liveAgent) continue;
        const role = squad.members[agent.id] ?? agent.role;
        const member = found.members.find(
          (candidate) => candidate.member_id === liveAgent.id && candidate.member_type === "agent",
        );
        if (!member) {
          change("squad", squad.name, `+ ${agent.name} joins ${squad.name}`, {
            op: "squad-member-add",
            squad: found.id,
            agent: liveAgent.id,
            role,
          });
        } else if (role && member.role !== role) {
          change(
            "squad",
            squad.name,
            `~ ${agent.name} role: ${preview(member.role)} → ${preview(role)}`,
            {
              op: "squad-member-role",
              squad: found.id,
              agent: liveAgent.id,
              role,
            },
          );
        }
      }
      const leader = rendered.agents.find((agent) => agent.id === squad.leader);
      const liveLeader = liveById.get(squad.leader);
      if (leader && liveLeader && found.leader_id !== liveLeader.id) {
        change("squad", squad.name, `~ leader → ${leader.name}`, {
          op: "squad-leader",
          squad: found.id,
          agent: liveLeader.id,
        });
      }
    }
  }

  // The Default workflow. The Agent context describes it, so the context waits while the
  // workflow is held back.
  const held = planWorkflow(rendered, live, { change, manual, note, liveById });

  if (!rendered.sharedContext) {
    note("context", "context", "the setup gives this workspace no Agent context: left alone");
  } else {
    const { lines, diff } = textDiff(norm(live.context), norm(rendered.sharedContext));
    if (lines && held) {
      note("context", "context", `Agent context (${differ(lines)}): waits for the workflow`);
    } else if (lines) {
      change(
        "context",
        "context",
        `~ Agent context (${differ(lines)})`,
        {
          op: "context",
          context: rendered.sharedContext,
        },
        diff,
      );
    }
  }
  return changes;
};

/** A move's status key as `plan` compares it: `""` for none, `?` while it isn't known. */
const moveKey = (
  specs: readonly StepSpec[],
  keys: ReadonlyMap<number, string>,
  to: number | undefined,
): string => (to === undefined ? "" : (keyAt(specs, keys, to) ?? "?"));

interface Emit {
  change: (kind: string, id: string, summary: string, operation: Operation, diff?: string) => void;
  manual: (kind: string, id: string, summary: string) => void;
  note: (kind: string, id: string, summary: string) => void;
  liveById: ReadonlyMap<string, LiveAgent>;
}

/** Plans the Default workflow. Returns true when something only a person can do holds it back. */
const planWorkflow = (
  rendered: RenderedSetup,
  live: MulticaLive,
  { change, manual, note, liveById }: Emit,
): boolean => {
  if (rendered.workflows.length === 0) return false;
  if ("problem" in live.workflow) {
    manual("workflow", "default", live.workflow.problem);
    return true;
  }
  const workflow = live.workflow;
  const merged = mergeWorkflows(rendered);

  // Each column's handler.
  let unresolved = false;
  const reported = new Set<string>();
  const once = (key: string, summary: string) => {
    unresolved = true;
    if (!reported.has(key)) manual("workflow", "default", summary);
    reported.add(key);
  };
  const owner = rendered.target.vars.owner;
  const handlerOf = (handoff: string): Handler | undefined => {
    if (handoff.startsWith("agent:")) {
      const id = handoff.slice("agent:".length);
      const agent = rendered.agents.find((candidate) => candidate.id === id);
      const found =
        liveById.get(id) ?? live.agents.find((candidate) => candidate.name === agent?.name);
      if (found) return { type: "agent", id: found.id };
      once(`agent:${id}`, `Agent: ${agent?.name ?? id}: no agent with this name; create it first`);
      return undefined;
    }
    if (handoff === "owner") {
      if (owner === undefined || owner === "") {
        once("owner", "owner: the target sets no vars.owner, so no member takes the owner's steps");
        return undefined;
      }
      const want = String(owner).toLowerCase();
      let found = live.members.filter((member) => memberName(member) === want);
      if (found.length === 0) {
        found = live.members.filter((member) => memberName(member).split(/\s+/)[0] === want);
      }
      const [only] = found;
      if (found.length === 1 && only) {
        if (!reported.has("owner")) {
          note(
            "workflow",
            "default",
            `owner: ${String(owner)} is ${only.name}${only.email ? ` <${only.email}>` : ""}`,
          );
        }
        reported.add("owner");
        return { type: "member", id: only.user_id };
      }
      once(
        "owner",
        found.length > 0
          ? `owner: ${String(owner)} matches ${found.map((member) => member.name).join(" and ")}: write the full name in vars.owner`
          : `owner: ${String(owner)}: no workspace member has this name`,
      );
      return undefined;
    }
    return undefined;
  };
  const specs: StepSpec[] = merged.columns.map((column) => {
    const handler = handlerOf(column.handoff);
    return {
      name: column.name,
      ...(column.key ? { key: column.key } : { category: column.category ?? "started" }),
      ...(handler ? { handler } : {}),
      instructions: column.instructions ?? "",
      ...(column.next === undefined ? {} : { next: column.next }),
      ...(column.back === undefined ? {} : { back: column.back }),
    };
  });
  if (unresolved) return true;

  const liveSteps = workflow.steps;
  const liveKeys = liveSteps.map((step) => step.status_key);
  const keys = customKeys(liveKeys, specs);
  const want = stepsFor(specs, keys);
  const wanted = specs.map((_, place) => keyAt(specs, keys, place));

  const notes: string[] = [];
  let diffs = "";
  specs.forEach((spec, place) => {
    const key = wanted[place];
    if (!key || !liveKeys.includes(key)) notes.push(`+ ${spec.name}`);
  });
  // Default never moves issues: those on a status it drops keep it, under hidden columns.
  for (const dropped of liveKeys.filter((key) => !wanted.includes(key))) notes.push(`- ${dropped}`);
  const order = liveKeys.filter((key) => wanted.includes(key));
  if (order.join() !== wanted.filter((key) => key && order.includes(key)).join()) {
    notes.push("column order");
  }
  specs.forEach((spec, place) => {
    const step = liveSteps.find((candidate) => candidate.status_key === wanted[place]);
    const target = want[place];
    if (!step || !target) return;
    const have = step.handler ?? { type: "none" };
    const wantHandler = target.handler ?? { type: "none" };
    const haveId = "id" in have ? (have.id ?? "") : "";
    const wantId = "id" in wantHandler ? wantHandler.id : "";
    if (have.type !== wantHandler.type || haveId !== wantId) notes.push(`${spec.name} handoff`);
    else if (target.handler) {
      const { lines, diff } = textDiff(norm(step.instructions), norm(target.instructions));
      if (lines) {
        notes.push(`${spec.name} instructions (${differ(lines)})`);
        diffs += `--- ${spec.name}\n${diff}\n`;
      }
    }
    const wantMoves = `${moveKey(specs, keys, spec.next)}|${moveKey(specs, keys, spec.back)}`;
    if (`${step.next_status_key ?? ""}|${step.back_status_key ?? ""}` !== wantMoves) {
      notes.push(`${spec.name} moves`);
    }
  });
  if (notes.length > 0) {
    change(
      "workflow",
      "default",
      `~ Default workflow: ${notes.join(", ")}`,
      {
        op: "workflow",
        workflow: workflow.id,
        specs,
      },
      diffs,
    );
  }

  // Projects on another workflow are listed, never switched.
  const on = new Set(workflow.project_ids);
  const command = ["multica", ...live.cli.profileArgs, "--workspace-id", live.workspace.id].join(
    " ",
  );
  for (const project of live.projects.filter((candidate) => !on.has(candidate.id))) {
    note(
      "project",
      project.id,
      `${project.name}: on another workflow; switch it back with \`${command} project workflow set ${project.id} default\``,
    );
  }
  return false;
};
