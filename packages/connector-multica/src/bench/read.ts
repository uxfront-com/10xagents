// Reads what `bench` measures from Multica, through the `multica` CLI: the workspace's agents and
// issues, and each issue's runs, timeline and comments. It never writes.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BenchQuery } from "10xagents";

import type { Env, MulticaCli } from "../multica.ts";
import { childEnv, findMultica, homeOf, runJson } from "../multica.ts";
import { pickProfile } from "../profiles.ts";

export interface Issue {
  id: string;
  identifier?: string;
  title?: string;
  parent_issue_id?: string | null;
  creator_type?: string;
  status?: string;
  created_at: string;
  updated_at?: string;
  last_activity_at?: string;
  metadata?: { pr_url?: string } | null;
}

export interface Usage {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface Run {
  id: string;
  agent_id: string;
  status: string;
  attempt?: number;
  trigger_summary?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  failure_reason?: string | null;
  is_leader_task?: boolean;
  priority?: string | number | null;
  usage?: Usage[] | null;
}

export interface TimelineEntry {
  type?: string;
  action?: string;
  created_at?: string;
  actor_type?: string;
  details?: { from?: string; to?: string } | null;
  content?: string;
}

export interface Attachment {
  id: string;
  filename?: string;
}

export interface Comment {
  author_id?: string;
  author_type?: string;
  created_at: string;
  content?: string;
  attachments?: Attachment[] | null;
}

/** A timeline, and whether the server cut it short. */
export interface Timeline {
  data: TimelineEntry[];
  warnings: string;
}

/** What the measures read, so tests can hand them fixtures. */
export interface BenchSource {
  workspace: { id: string; name: string; slug: string };
  /** Agent names by id, archived agents included. */
  agentNames: Map<string, string>;
  /** Every issue in the workspace, oldest first. */
  issues: Issue[];
  runs(issueId: string): Run[];
  timeline(issueId: string, statusOnly: boolean): Promise<Timeline>;
  comments(issueId: string): Comment[];
  /** An attachment's text, or `null` when it can't be read. */
  attachment(attachment: Attachment): string | null;
  /** Lines worth showing, like a timeline read from the server. */
  notes: string[];
  /** Removes what it downloaded. */
  close(): void;
}

type Guard<T> = (value: unknown) => value is T;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isNamed: Guard<{ id: string; name: string; slug?: string }> = (
  value,
): value is { id: string; name: string; slug?: string } =>
  isObject(value) && typeof value.id === "string" && typeof value.name === "string";
const isIssue: Guard<Issue> = (value): value is Issue =>
  isObject(value) && typeof value.id === "string" && typeof value.created_at === "string";
const isRun: Guard<Run> = (value): value is Run =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.agent_id === "string" &&
  typeof value.status === "string";
const isEntry: Guard<TimelineEntry> = (value): value is TimelineEntry => isObject(value);
const isComment: Guard<Comment> = (value): value is Comment =>
  isObject(value) && typeof value.created_at === "string";
/** The records in a list that have the fields `guard` checks. */
const list = <T>(value: unknown, guard: Guard<T>): T[] =>
  Array.isArray(value) ? value.filter((item: unknown) => guard(item)) : [];
/** The list itself, or the list a field of an object holds. */
const listIn = <T>(value: unknown, field: string, guard: Guard<T>): T[] =>
  Array.isArray(value) ? list(value, guard) : isObject(value) ? list(value[field], guard) : [];

/** What `multica <args>` printed, and what it wrote to standard error, where it warns of a cut timeline. */
const spawn = (
  cli: MulticaCli,
  args: readonly string[],
  workspace: string,
): { stdout: string; warnings: string } => {
  const result = spawnSync(cli.bin, [...cli.profileArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    cwd: homeOf(cli.env),
    env: childEnv(cli.env, workspace),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "").trim();
    throw new Error(`multica ${args.slice(0, 3).join(" ")}: ${reason}`, { cause: result.error });
  }
  return { stdout: result.stdout, warnings: result.stderr ?? "" };
};

const spawnJson = (
  cli: MulticaCli,
  args: readonly string[],
  workspace: string,
): { data: unknown; warnings: string } => {
  const { stdout, warnings } = spawn(cli, [...args, "--output", "json"], workspace);
  const data: unknown = JSON.parse(stdout);
  return { data, warnings };
};

export interface ReadContext {
  env: Env;
  desktop?: string;
}

/** Opens the target's workspace for reading, with the profile the query names or the only one. */
export const openSource = async (query: BenchQuery, context: ReadContext): Promise<BenchSource> => {
  const log = query.log ?? (() => {});
  const bin = findMultica(context.env, context.desktop);
  const profile = await pickProfile(homeOf(context.env), query.profile, query.ask, log);
  const cli: MulticaCli = {
    bin,
    profileArgs: profile ? ["--profile", profile] : [],
    env: context.env,
  };
  const want = query.target.workspace;
  const workspaces = list(runJson(cli, ["workspace", "list"]), isNamed);
  if (workspaces.length === 0) {
    throw new Error("this profile reaches no workspace: log in with another one");
  }
  const chosen = workspaces.find((ws) => [ws.id, ws.slug, ws.name].includes(want));
  if (!chosen) {
    throw new Error(
      `no workspace ${want} for this profile: ${workspaces.map((ws) => ws.slug || ws.name).join(", ")}`,
    );
  }
  const workspace = { id: chosen.id, name: chosen.name, slug: chosen.slug ?? "" };
  const json = (args: string[]) => runJson(cli, args, workspace.id);
  const notes: string[] = [];

  // Archived agents too, so the runs of a seat you replaced keep its name.
  const agentNames = new Map(
    list(json(["agent", "list", "--include-archived"]), isNamed).map((a) => [a.id, a.name]),
  );
  // Oldest first, so an issue created during the walk lands on the last page, instead of shifting
  // the pages, and by id, so no issue counts twice.
  const byId = new Map<string, Issue>();
  const listArgs = [
    "issue",
    "list",
    "--sort",
    "created_at",
    "--direction",
    "asc",
    "--limit",
    "100",
  ];
  for (let offset = 0; ; offset += 100) {
    const page = json([...listArgs, "--offset", String(offset)]);
    const issues = listIn(page, "issues", isIssue);
    for (const issue of issues) byId.set(issue.id, issue);
    const more = isObject(page) && page.has_more === true;
    if (!more || issues.length === 0) break;
  }

  const runs = new Map<string, Run[]>();
  const timelines = new Map<string, Promise<Timeline>>();
  const comments = new Map<string, Comment[]>();

  // A multica CLI from before 20 August 2026 has no `issue timeline`, though the server has served
  // the same list since March. So when the CLI rejects the command, read the list from the server,
  // with the profile's own address and token, which travels in a header, never on a command line.
  let fromServer = false;
  const serverTimeline = async (issueId: string, statusOnly: boolean): Promise<Timeline> => {
    const file = join(
      homeOf(context.env),
      ".multica",
      ...(profile ? ["profiles", profile] : []),
      "config.json",
    );
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`can't read the server's address and token from ${file}`, { cause: error });
    }
    const fields = isObject(config) ? config : {};
    const token = typeof fields.token === "string" ? fields.token : "";
    if (!token) throw new Error(`${file} holds no token: log in with this profile first`);
    const server = typeof fields.server_url === "string" ? fields.server_url : "";
    const url = (server || "https://api.multica.ai").replace(/^ws/, "http").replace(/\/+$/, "");
    const response = await fetch(`${url}/api/issues/${encodeURIComponent(issueId)}/timeline`, {
      headers: { authorization: `Bearer ${token}`, "x-workspace-id": workspace.id },
    });
    if (!response.ok) {
      throw new Error(`timeline ${issueId}: the server answered HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const entries = listIn(body, "entries", isEntry);
    const cut = response.headers.get("x-timeline-truncated");
    return {
      data: statusOnly
        ? entries.filter((e) => e.type === "activity" && e.action === "status_changed")
        : entries,
      warnings: cut ? `warning: timeline truncated by the server cap (${cut})` : "",
    };
  };
  const readTimeline = async (issueId: string, statusOnly: boolean): Promise<Timeline> => {
    if (!fromServer) {
      try {
        const filter = statusOnly ? ["--action", "status_changed"] : [];
        const { data, warnings } = spawnJson(
          cli,
          ["issue", "timeline", issueId, ...filter],
          workspace.id,
        );
        return { data: list(data, isEntry), warnings };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/unknown (flag: --|command "timeline")/.test(error.message)
        ) {
          throw error;
        }
        fromServer = true;
        notes.push(
          "Your multica CLI has no `issue timeline`, so timelines came from the server, with your profile's token.",
        );
      }
    }
    return serverTimeline(issueId, statusOnly);
  };

  const scratch = mkdtempSync(join(tmpdir(), "10xagents-bench-"));
  return {
    workspace,
    agentNames,
    issues: [...byId.values()],
    notes,
    runs: (issueId) => {
      let read = runs.get(issueId);
      if (!read) {
        read = list(json(["issue", "runs", issueId]), isRun);
        runs.set(issueId, read);
      }
      return read;
    },
    timeline: (issueId, statusOnly) => {
      const key = `${issueId}:${statusOnly}`;
      let read = timelines.get(key);
      if (!read) {
        read = readTimeline(issueId, statusOnly);
        timelines.set(key, read);
      }
      return read;
    },
    comments: (issueId) => {
      let read = comments.get(issueId);
      if (!read) {
        read = listIn(json(["issue", "comment", "list", issueId, "--full"]), "comments", isComment);
        comments.set(issueId, read);
      }
      return read;
    },
    attachment: (attachment) => {
      try {
        // `attachment download` saves the file into the folder `-o` names and prints its path as
        // JSON. Older CLIs print no JSON and don't create the folder, so make it first.
        const dir = join(scratch, attachment.id);
        mkdirSync(dir, { recursive: true });
        let path = join(dir, attachment.filename ?? "");
        const printed = spawn(
          cli,
          ["attachment", "download", attachment.id, "-o", dir],
          workspace.id,
        ).stdout;
        try {
          const parsed: unknown = JSON.parse(printed);
          if (isObject(parsed) && typeof parsed.path === "string") {
            path = parsed.path;
          }
        } catch {
          // An older CLI prints no JSON; the file is still where `-o` put it.
        }
        return readFileSync(path, "utf8");
      } catch (error) {
        log(
          `  couldn't read ${attachment.filename ?? attachment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    close: () => rmSync(scratch, { recursive: true, force: true }),
  };
};
