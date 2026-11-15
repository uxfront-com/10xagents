// Reads a workspace's state from Multica: everything `plan` compares, in one pass.

import type { PullOptions, RenderedTarget } from "10xagents";

import type { Env, MulticaCli } from "./multica.ts";
import { findMultica, homeOf, runJson } from "./multica.ts";
import { pickProfile } from "./profiles.ts";

export interface LiveWorkspace {
  id: string;
  name: string;
  slug: string;
}

export interface LiveMember {
  user_id: string;
  name: string;
  email?: string;
}

export interface LiveSkill {
  id: string;
  name: string;
  /** Every file, by path, as stored. `SKILL.md` is the skill's content. */
  files: Record<string, string>;
}

export interface LiveAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  thinking_level: string;
  max_concurrent_tasks: string;
  instructions: string;
  skills: { name: string; enabled: boolean }[];
}

export interface LiveSquad {
  id: string;
  name: string;
  instructions: string;
  leader_id: string;
  members: { member_id: string; member_type: string; role: string }[];
}

export interface LiveStep {
  status_key: string;
  handler?: { type: string; id?: string };
  instructions?: string;
  next_status_key?: string;
  back_status_key?: string;
}

/** An active status in the workspace's catalog. */
export interface LiveStatus {
  key: string;
  name: string;
}

/** The Default workflow, with the workspace's active statuses, or why it can't be synced. */
export type LiveWorkflow =
  | { problem: string }
  | { id: string; steps: LiveStep[]; project_ids: string[]; statuses: LiveStatus[] };

/** The Multica connector's live state. */
export type MulticaLive = {
  connector: "multica";
  cli: MulticaCli;
  /** The profile's name, `""` for the default one. */
  profile: string;
  workspace: LiveWorkspace;
  context: string;
  members: LiveMember[];
  skills: LiveSkill[];
  agents: LiveAgent[];
  /** The target's squad, `null` when the workspace has none with its name. */
  squad: LiveSquad | null;
  workflow: LiveWorkflow;
  projects: { id: string; name: string }[];
};

/** A record read from Multica's JSON. */
type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown, what: string): Row[] => {
  if (!Array.isArray(value)) throw new Error(`multica ${what}: expected a list`);
  return value.filter(isRow);
};
const row = (value: unknown, what: string): Row => {
  if (!isRow(value)) throw new Error(`multica ${what}: expected an object`);
  return value;
};
/** A string or number field as text. Anything else is empty. */
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";

export interface PullContext {
  env: Env;
  desktop?: string;
}

/** Reads the workspace `target` syncs to, with the profile and workspace `options` choose. */
export const pull = async (
  target: RenderedTarget,
  options: PullOptions,
  context: PullContext,
): Promise<MulticaLive> => {
  const log = options.log ?? (() => {});
  const bin = findMultica(context.env, context.desktop);
  const profile = await pickProfile(homeOf(context.env), options.profile, options.ask);
  const cli: MulticaCli = {
    bin,
    profileArgs: profile ? ["--profile", profile] : [],
    env: context.env,
  };
  log(`Profile: ${profile || "(default)"}`);

  const want = options.workspace ?? target.workspace;
  const workspaces = rows(runJson(cli, ["workspace", "list"]), "workspace list");
  const found = workspaces.find((ws) => [ws.id, ws.slug, ws.name].includes(want));
  if (!found) throw new Error(`no workspace ${want} for this profile`);
  const workspace: LiveWorkspace = {
    id: text(found.id),
    name: text(found.name),
    slug: text(found.slug),
  };
  log(`Workspace: ${workspace.name}`);
  const id = workspace.id;
  const json = (args: string[], scoped = true) => runJson(cli, args, scoped ? id : undefined);

  const agentContext = text(row(json(["workspace", "get", id], false), "workspace get").context);
  const members = rows(
    json(["workspace", "member", "list", id], false),
    "workspace member list",
  ).map((member): LiveMember => ({
    user_id: text(member.user_id),
    name: text(member.name),
    ...(member.email === undefined ? {} : { email: text(member.email) }),
  }));

  const skills = rows(json(["skill", "list"]), "skill list").map((listed): LiveSkill => {
    const full = row(json(["skill", "get", text(listed.id), "--with-content"]), "skill get");
    const files: Record<string, string> = { "SKILL.md": text(full.content) };
    for (const file of rows(full.files ?? [], "skill get")) {
      files[text(file.path)] = text(file.content);
    }
    return { id: text(listed.id), name: text(listed.name), files };
  });

  const agents = rows(json(["agent", "list"]), "agent list").map((listed): LiveAgent => {
    const full = row(json(["agent", "get", text(listed.id)]), "agent get");
    return {
      id: text(listed.id),
      name: text(listed.name),
      description: text(full.description),
      model: text(full.model),
      thinking_level: text(full.thinking_level),
      max_concurrent_tasks: text(full.max_concurrent_tasks),
      instructions: text(full.instructions),
      skills: rows(full.skills ?? [], "agent get").map((skill) => ({
        name: text(skill.name),
        enabled: skill.enabled !== false,
      })),
    };
  });

  let squad: LiveSquad | null = null;
  const squadName = target.squad?.name;
  if (squadName !== undefined) {
    const listed = rows(json(["squad", "list"]), "squad list").find(
      (candidate) => candidate.name === squadName,
    );
    if (listed) {
      const full = row(json(["squad", "get", text(listed.id)]), "squad get");
      squad = {
        id: text(listed.id),
        name: squadName,
        instructions: text(full.instructions),
        leader_id: text(full.leader_id),
        members: rows(json(["squad", "member", "list", text(listed.id)]), "squad member list").map(
          (member) => ({
            member_id: text(member.member_id),
            member_type: text(member.member_type),
            role: text(member.role),
          }),
        ),
      };
    }
  }

  const workflow = pullWorkflow(json);
  const projects = rows(json(["project", "list"]), "project list").map((project) => ({
    id: text(project.id),
    name: text(project.title ?? project.name),
  }));

  return {
    connector: "multica",
    cli,
    profile,
    workspace,
    context: agentContext,
    members,
    skills,
    agents,
    squad,
    workflow,
    projects,
  };
};

/** What an older CLI or server says when it lacks a command: `cli`, `server` or neither. */
const missing = (error: unknown): "cli" | "server" | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown command|unknown flag/i.test(message)) return "cli";
  if (/returned 404/.test(message)) return "server";
  return undefined;
};

const pullWorkflow = (json: (args: string[]) => unknown): LiveWorkflow => {
  let listed: Row[];
  try {
    listed = rows(json(["workflow", "list"]), "workflow list");
  } catch (error) {
    const lacks = missing(error);
    if (lacks === "cli") {
      return {
        problem:
          "this multica CLI has no `workflow` command: update it, or build the workflow by hand",
      };
    }
    if (lacks === "server") {
      return {
        problem: "this Multica server has no workflows: update it, or build the workflow by hand",
      };
    }
    throw error;
  }
  const found = listed.find((workflow) => workflow.is_default === true);
  if (!found) return { problem: "Multica listed no Default workflow" };
  const full = row(json(["workflow", "get", text(found.id)]), "workflow get");
  // Without the names, `plan` can't see a rename, and writing the workflow by name would make
  // new statuses and leave issues on the old ones. So the workflow waits.
  let statuses: LiveStatus[];
  try {
    statuses = rows(json(["issue-status", "list"]), "issue-status list")
      .filter((status) => !status.archived_at)
      .map((status) => ({ key: text(status.key), name: text(status.name) }));
  } catch (error) {
    const lacks = missing(error);
    if (lacks === "cli") {
      return {
        problem:
          "this multica CLI can't list statuses, so it can't rename columns in place: update it",
      };
    }
    if (lacks === "server") {
      return {
        problem:
          "this Multica server can't list statuses, so it can't rename columns in place: update it",
      };
    }
    throw error;
  }
  return {
    id: text(found.id),
    steps: rows(full.steps ?? [], "workflow get").map(toStep),
    project_ids: Array.isArray(full.project_ids) ? full.project_ids.map(text) : [],
    statuses,
  };
};

/** A step as Multica returns it, with only the fields the sync compares. */
export const toStep = (step: Row): LiveStep => {
  const handler = isRow(step.handler) ? step.handler : null;
  return {
    status_key: text(step.status_key),
    ...(handler
      ? {
          handler: {
            type: text(handler.type),
            ...(handler.id === undefined || handler.id === null ? {} : { id: text(handler.id) }),
          },
        }
      : {}),
    ...(step.instructions === undefined ? {} : { instructions: text(step.instructions) }),
    ...(step.next_status_key ? { next_status_key: text(step.next_status_key) } : {}),
    ...(step.back_status_key ? { back_status_key: text(step.back_status_key) } : {}),
  };
};
