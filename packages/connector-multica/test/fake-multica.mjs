#!/usr/bin/env node
// A stand-in for the `multica` CLI. It keeps a workspace's state in the JSON file that
// FAKE_MULTICA_STATE names, answers the commands the connector runs, and logs every call with
// its working directory and its MULTICA_* variables.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const statePath = process.env.FAKE_MULTICA_STATE;
if (!statePath) {
  console.error("No server configured");
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
let args = process.argv.slice(2);
let profile = "";
if (args[0] === "--profile") {
  profile = args[1] ?? "";
  args = args.slice(2);
}
const json = args.at(-2) === "--output" && args.at(-1) === "json";
if (json) args = args.slice(0, -2);
const stdin = args.includes("--context-stdin") ? readFileSync(0, "utf8") : undefined;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("MULTICA_")),
);
state.calls.push({
  args,
  profile,
  cwd: process.cwd(),
  env,
  ...(stdin === undefined ? {} : { stdin }),
});

const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (value) => {
  save();
  process.stdout.write(json ? JSON.stringify(value) : "ok\n");
  process.exit(0);
};
const fail = (message) => {
  save();
  console.error(message);
  process.exit(1);
};
const flag = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const command = args.slice(0, 3).join(" ");
for (const [prefix, message] of Object.entries(state.fail ?? {})) {
  if (command.startsWith(prefix)) fail(message);
}
if (state.profile !== undefined && profile !== state.profile) fail("No server configured");
const ws = state.workspace;
const scoped = () => {
  if (process.env.MULTICA_WORKSPACE_ID !== ws.id) fail("no workspace selected");
};
let ids = state.nextId ?? 1;
const newId = (kind) => {
  state.nextId = ++ids;
  return `${kind}-${ids}`;
};

/** The files of a stored (uncompressed) zip, by name. */
const unzip = (buffer) => {
  const files = new Map();
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    files.set(name, buffer.subarray(start, start + size).toString("utf8"));
    at = start + size;
  }
  return files;
};

const BUILT_IN_NAMES = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
const BUILT_IN = Object.keys(BUILT_IN_NAMES);
const statusKeys = () => [...BUILT_IN, ...(state.statuses ?? []).map((status) => status.key)];
/** The catalog `issue-status list` returns: the built-in statuses, then the custom ones. */
const catalog = () => [
  ...BUILT_IN.map((key) => ({ key, name: BUILT_IN_NAMES[key], is_system: true })),
  ...(state.statuses ?? []).map((status) => ({ ...status, is_system: false })),
];

const [a, b, c] = args;
const agent = (id) => state.agents.find((item) => item.id === id) ?? fail(`no agent ${id}`);
const squad = (id) => state.squads.find((item) => item.id === id) ?? fail(`no squad ${id}`);

if (a === "workspace" && b === "list") out([{ id: ws.id, name: ws.name, slug: ws.slug }]);
if (a === "workspace" && b === "get") out({ id: ws.id, name: ws.name, context: ws.context });
if (a === "workspace" && b === "member" && c === "list") out(state.members);
if (a === "workspace" && b === "update") {
  ws.context = stdin;
  out({});
}
if (a === "skill" && b === "list") {
  scoped();
  out(state.skills.map(({ id, name }) => ({ id, name })));
}
if (a === "skill" && b === "get") {
  scoped();
  out(state.skills.find((skill) => skill.id === c) ?? fail(`no skill ${c}`));
}
if (a === "skill" && b === "import") {
  scoped();
  if (flag("--on-conflict") !== "overwrite") fail("conflict");
  const files = unzip(readFileSync(flag("--file")));
  const folder = [...files.keys()][0].split("/")[0];
  const read = (path) => files.get(`${folder}/${path}`);
  const name = /^name:\s*(.*)$/m.exec(read("SKILL.md") ?? "")?.[1]?.trim() ?? folder;
  const rest = [...files]
    .filter(([path]) => path !== `${folder}/SKILL.md`)
    .map(([path, content]) => ({ path: path.slice(folder.length + 1), content }));
  const existing = state.skills.find((skill) => skill.name === name);
  if (existing) Object.assign(existing, { content: read("SKILL.md"), files: rest });
  else state.skills.push({ id: newId("skill"), name, content: read("SKILL.md"), files: rest });
  out({});
}
if (a === "agent" && b === "list") {
  scoped();
  out(state.agents.map(({ id, name }) => ({ id, name })));
}
if (a === "agent" && b === "get") {
  scoped();
  out(agent(c));
}
if (a === "agent" && b === "update") {
  scoped();
  const target = agent(c);
  for (const [option, field] of [
    ["--instructions", "instructions"],
    ["--description", "description"],
    ["--model", "model"],
    ["--thinking-level", "thinking_level"],
    ["--max-concurrent-tasks", "max_concurrent_tasks"],
  ]) {
    const value = flag(option);
    if (value !== undefined)
      target[field] = field === "max_concurrent_tasks" ? Number(value) : value;
  }
  out({});
}
if (a === "agent" && b === "skills" && c === "add") {
  scoped();
  const target = agent(args[3]);
  for (const id of flag("--skill-ids").split(",")) {
    const skill = state.skills.find((item) => item.id === id) ?? fail(`no skill ${id}`);
    target.skills.push({ id, name: skill.name, enabled: true });
  }
  out({});
}
if (a === "squad" && b === "list") {
  scoped();
  out(state.squads.map(({ id, name }) => ({ id, name })));
}
if (a === "squad" && b === "get") {
  scoped();
  const { members: _members, ...rest } = squad(c);
  out(rest);
}
if (a === "squad" && b === "member" && c === "list") {
  scoped();
  out(squad(args[3]).members);
}
if (a === "squad" && b === "member" && c === "add") {
  scoped();
  squad(args[3]).members.push({
    member_id: flag("--member-id"),
    member_type: flag("--type"),
    role: flag("--role"),
  });
  out({});
}
if (a === "squad" && b === "member" && c === "set-role") {
  scoped();
  const member = squad(args[3]).members.find((item) => item.member_id === flag("--member-id"));
  member.role = flag("--role");
  out({});
}
if (a === "squad" && b === "update") {
  scoped();
  const target = squad(c);
  if (flag("--instructions") !== undefined) target.instructions = flag("--instructions");
  if (flag("--leader") !== undefined) target.leader_id = flag("--leader");
  out({});
}
if (a === "workflow" && b === "list") {
  scoped();
  if (state.noWorkflowCommand) fail('Error: unknown command "workflow" for "multica"');
  out(state.workflows.map(({ id, is_default }) => ({ id, is_default })));
}
if (a === "workflow" && b === "get") {
  scoped();
  out(state.workflows.find((item) => item.id === c) ?? fail(`no workflow ${c}`));
}
if (a === "workflow" && b === "update") {
  scoped();
  const workflow = state.workflows.find((item) => item.id === c) ?? fail(`no workflow ${c}`);
  const steps = JSON.parse(readFileSync(flag("--steps-file"), "utf8"));
  state.statuses ??= [];
  const written = steps.map((step) => {
    let key = step.status_key;
    if (!key) {
      const { name } = step.new_status;
      const found = state.statuses.find((status) => status.name === name);
      key = found?.key ?? name.toLowerCase().replace(/\s+/g, "_");
      if (!found) state.statuses.push({ key, name, category: step.new_status.category });
    }
    for (const move of [step.next_status_key, step.back_status_key]) {
      if (move && !statusKeys().includes(move)) fail(`unknown status ${move}`);
    }
    return {
      status_key: key,
      handler: step.handler ?? null,
      instructions: step.instructions ?? "",
      next_status_key: step.next_status_key ?? null,
      back_status_key: step.back_status_key ?? null,
    };
  });
  workflow.steps = written;
  out({ id: workflow.id, steps: written });
}
if (a === "issue-status" && b === "list") {
  scoped();
  out(catalog().map((status) => ({ archived_at: null, ...status })));
}
if (a === "issue-status" && b === "update") {
  scoped();
  // As Multica does: a built-in status can't change, and names are unique, case-insensitive.
  if (BUILT_IN.includes(c)) fail("Error: built-in statuses cannot be modified");
  const status = (state.statuses ?? []).find((item) => item.key === c) ?? fail(`no status ${c}`);
  const name = flag("--name");
  if (name !== undefined) {
    const clash = catalog().find(
      (item) => item.key !== c && item.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) fail("Error: returned 409: a status with this name already exists");
    status.name = name;
  }
  out(status);
}
// What `bench` reads: issues, their runs, timelines and comments, and attachments.
if (a === "issue" && b === "list") {
  scoped();
  const offset = Number(flag("--offset") ?? 0);
  const limit = Number(flag("--limit") ?? 100);
  const issues = state.issues ?? [];
  out({ issues: issues.slice(offset, offset + limit), has_more: offset + limit < issues.length });
}
if (a === "issue" && b === "runs") {
  scoped();
  out(state.runs?.[c] ?? []);
}
if (a === "issue" && b === "timeline") {
  scoped();
  if (state.noTimeline) fail('Error: unknown command "timeline" for "multica issue"');
  const action = flag("--action");
  const entries = (state.timelines?.[c] ?? []).filter((e) => !action || e.action === action);
  if (state.truncated?.[c]) {
    process.stderr.write(`warning: timeline truncated by the server cap (${state.truncated[c]})\n`);
  }
  out(entries);
}
if (a === "issue" && b === "comment" && c === "list") {
  scoped();
  out(state.comments?.[args[3]] ?? []);
}
if (a === "attachment" && b === "download") {
  scoped();
  const attachment = state.attachments?.[c] ?? fail(`no attachment ${c}`);
  const path = join(flag("-o"), attachment.filename);
  writeFileSync(path, attachment.text);
  save();
  process.stdout.write(JSON.stringify({ path }));
  process.exit(0);
}
if (a === "project" && b === "list") {
  scoped();
  out(state.projects);
}
fail(`unknown command "${args.join(" ")}"`);
