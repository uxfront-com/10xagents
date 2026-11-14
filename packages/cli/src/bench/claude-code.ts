// The Claude Code collector: what fills the agents' context, from the Claude Code transcripts on
// the machine that runs them. A platform's run records can't show it, since their usage counts
// the subagents with the main loop. It reports counts and sizes only: no prompts, replies, file
// contents, paths or command text.

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { BenchQuery, BenchResult, Collector, MetricResult } from "../contract.ts";
import { pct, sorted, sum, value } from "./stats.ts";

/** Dollars per million tokens at Anthropic's list prices, as Multica's price table has them. */
export const TRANSCRIPT_PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead: number }>
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
const FALLBACK_MODEL = "claude-opus-5-5";

export const CLAUDE_CODE_METRICS = [
  "sessions",
  "session-runs",
  "calls-per-run-p50",
  "calls-per-run-p90",
  "context-at-start-p50",
  "context-at-start-p90",
  "context-peak",
  "compactions",
  "cache-write-1h-share",
  "session-cost",
  "subagent-cost-share",
  "forks",
  "agents-md-reads-per-run",
  "skill-loads-per-run",
  "tool-output-calls",
  "tool-output-tokens",
  "tool-output-tokens-per-call",
  "tool-output-largest",
  "tool-output-images",
];

/** A transcript line, as Claude Code writes it. Only the fields read here. */
interface Entry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  uuid?: string;
  requestId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Usage;
  };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  text?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  /** A tool call's label, worked out as the line is read. */
  label?: string;
  /** A tool result's size in characters and its images, worked out as the line is read. */
  size?: number;
  images?: number;
}

export interface UsageSum {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  cost: number;
}

interface Output {
  count: number;
  chars: number;
  max: number;
  images: number;
}

/** One session's numbers for the runs in one segment of the window. */
export interface SessionRow {
  session: string;
  segment: string;
  /** The issue key from the session's working directory, when it holds one. */
  issue: string | null;
  seat: string;
  runs: {
    start: string;
    calls: number;
    contextAtStart: number | null;
    contextPeak: number | null;
  }[];
  compactions: number;
  usage: UsageSum;
  subagents: { calls: number; models: string[]; usage: UsageSum };
  agentTypes: Record<string, number>;
  tools: Record<string, number>;
  outputs: Record<string, Output>;
  repeatReads: number;
  agentsMdReads: number;
  skillLoads: Record<string, number>;
}

const blank = (): UsageSum => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  write5m: 0,
  write1h: 0,
  cost: 0,
});

const ms = (entry: Entry): number => Date.parse(entry.timestamp ?? "") || 0;
const blocks = (entry: Entry): Block[] =>
  Array.isArray(entry.message?.content)
    ? (entry.message.content as unknown[]).filter((b): b is Block => !!b && typeof b === "object")
    : [];
const isToolResult = (entry: Entry): boolean => blocks(entry).some((b) => b.type === "tool_result");
const contentParts = (block: Block): Block[] =>
  Array.isArray(block.content)
    ? (block.content as unknown[]).filter((c): c is Block => !!c && typeof c === "object")
    : [];
const resultSize = (block: Block): number =>
  block.size !== undefined
    ? block.size
    : typeof block.content === "string"
      ? block.content.length
      : contentParts(block).reduce(
          (n, c) => n + (c.type === "text" ? (c.text ?? "").length : 0),
          0,
        );
const resultImages = (block: Block): number =>
  block.images ?? contentParts(block).filter((c) => c.type === "image").length;
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

// A tool call's label: its name, and for a few tools a short class of what it touched, never the
// path or the command itself. Every word in a label comes from a list here, or from a name made only
// of plain characters, so nothing the agent typed (a path, a client's name, a token) reaches the
// report.
const plain = (word: string | undefined, fallback = "other"): string =>
  word !== undefined && /^[A-Za-z][\w.:-]{0,39}$/.test(word) ? word : fallback;
const fileClass = (path: string | undefined): string => {
  const name = basename(path ?? "");
  if (["AGENTS.md", "CLAUDE.md", "SKILL.md", "evidence.md", "package.json"].includes(name)) {
    return name;
  }
  if (/\.(patch|diff)$/.test(name)) return "a diff file";
  const ext = extname(name);
  return /^\.[a-z0-9]{1,5}$/i.test(ext) ? `a ${ext} file` : "another file";
};
const COMMANDS = new Set(
  (
    "git gh multica pnpm npm npx node cat sed grep rg ls find head tail jq curl python3 python " +
    "tsc vitest playwright wc diff echo test mkdir rm cp mv sleep until while for if awk sort " +
    "uniq timeout bash sh turbo oxlint oxfmt wrangler docker tar unzip"
  ).split(" "),
);
const SUBCOMMANDS: Record<string, string> = {
  git: "diff log status show fetch merge merge-base merge-tree rev-parse rev-list switch checkout commit push pull add reset stash branch blame grep ls-files worktree cherry-pick rebase tag remote config clean restore",
  gh: "pr api run issue repo release workflow auth",
  multica: "issue repo attachment agent workspace squad label project autopilot runtime",
  pnpm: "install i run test build exec dlx add why ls lint format check-types typecheck dev preview changeset",
  npm: "install i ci run test exec ls",
};
const SUBSUBCOMMANDS: Record<string, string> = {
  "gh pr": "view checks create ready list diff edit merge",
  "multica issue":
    "get list comment children metadata status update create runs usage wakeup label pull-requests cancel-task",
  "multica repo": "checkout",
};
const commandHead = (command: string | undefined): string => {
  // The first command that isn't a `cd` or a variable, as in `cd x && git diff`.
  const segment =
    (command ?? "")
      .split(/&&|\|\||;|\|/)
      .map((part) => part.trim())
      .find((part) => part && !/^(cd|export|\w+=\S*$)\b/.test(part)) ?? "";
  const words = segment.split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
  const first = basename(words[0] ?? "");
  if (!COMMANDS.has(first)) return "another command";
  const args = words.slice(1).filter((w, i, all) => {
    if (w.startsWith("-")) return false;
    return !["-C", "--profile", "--prefix"].includes(all[i - 1] ?? "");
  });
  let head = first;
  for (const table of [SUBCOMMANDS, SUBSUBCOMMANDS]) {
    const next = args[head.split(" ").length - 1];
    if (next === undefined || !(table[head] ?? "").split(" ").includes(next)) break;
    head = `${head} ${next}`;
  }
  return head;
};
const labelOf = (block: Block): string => {
  if (block.label !== undefined) return block.label;
  const input = block.input ?? {};
  if (block.name === "Read") return `Read ${fileClass(str(input.file_path))}`;
  if (block.name === "Bash") return `Bash ${commandHead(str(input.command))}`;
  if (block.name === "Skill") {
    return `Skill ${plain(str(input.skill) ?? str(input.command) ?? str(input.name))}`;
  }
  if (block.name === "Agent" || block.name === "Task") {
    return `Agent ${plain(str(input.subagent_type), "(no type)")}`;
  }
  return plain(block.name, "another tool");
};

// Which seat a session belongs to: the platform's brief in the working directory names it
// ("**You are: QA**"); once that directory is gone, the skills the session loaded tell the seats
// of the Ultracode squad apart.
const seatOf = (cwd: string, skills: ReadonlySet<string>): string => {
  try {
    const brief = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    const name = brief.match(/\*\*You are: ([^*\n]+)\*\*/)?.[1]?.trim();
    if (name) return plain(name.replaceAll(" ", "-"), "unknown").replaceAll("-", " ");
  } catch {
    // The working directory is gone, so the skills decide.
  }
  if (skills.has("adversarial-verification")) return "QA (by its skills)";
  if (skills.has("squad-planning")) return "Planner (by its skills)";
  if (skills.has("squad-protocol") && skills.has("copywriting")) {
    return "Technical Writer (by its skills)";
  }
  if (skills.has("local-verification")) return "Engineer or Technical Writer (by its skills)";
  if (["technical-writing", "copywriting", "writing-voice"].some((s) => skills.has(s))) {
    return "a seat that writes (by its skills)";
  }
  return "unknown";
};

/** An issue key from a working directory: a `<key>-<12 hex>` folder, like `ab-12-0123456789ab`. */
const issueOf = (cwd: string): string | null => {
  const keys = cwd
    .split("/")
    .map((part) => /^([a-z]+-\d+)-[0-9a-f]{12}$/i.exec(part)?.[1])
    .filter((key): key is string => key !== undefined);
  const key = keys.at(-1);
  // The platform cuts a folder's label to 11 characters, so a label that long may be a cut key.
  return key && key.length < 11 ? key.toUpperCase() : null;
};

// Streaming writes one line per content block, each with the message's usage so far, so a call is
// a message id, and its usage is the last line's.
const callsOf = (entries: readonly Entry[]) => {
  const calls = new Map<string, { usage: Usage; model: string }>();
  for (const e of entries) {
    if (e.type !== "assistant" || !e.message?.usage || e.message.model === "<synthetic>") continue;
    const key = e.message.id ?? e.requestId ?? e.uuid ?? "";
    calls.set(key, { usage: e.message.usage, model: e.message.model ?? "" });
  }
  return [...calls.values()];
};

const firstText = (entry: Entry): string =>
  typeof entry.message?.content === "string"
    ? entry.message.content
    : (blocks(entry).find((b) => b.type === "text")?.text ?? "");
// A run starts with the platform's prompt: a user entry that isn't meta, a compact summary, a tool
// result, a background-task notice or an interruption.
const isRunStart = (e: Entry): boolean =>
  e.type === "user" &&
  e.message?.role === "user" &&
  !e.isMeta &&
  !e.isCompactSummary &&
  !isToolResult(e) &&
  e.origin?.kind !== "task-notification" &&
  !/^\s*(<task-notification>|\[Request interrupted)/.test(firstText(e));
const contextOf = (usage: Usage): number =>
  (usage.input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0);

const isEntry = (input: unknown): input is Entry =>
  !!input && typeof input === "object" && !Array.isArray(input);

/** The start of a text, which is all that tells a run's first line from the others. */
const head = (text: string): string => text.trimStart().slice(0, 64);

/**
 * The parts of a line the measures read, and nothing else: no tool output, prompt, reply or file
 * text. A tool call keeps its label, a tool result its size and images, and a text block the start
 * a run's first line is told by. Sessions hold gigabytes of tool output, so this is what keeps
 * memory flat.
 */
const slim = (entry: Entry): Entry => {
  const { message } = entry;
  let content: unknown;
  if (typeof message?.content === "string") content = head(message.content);
  else if (message) {
    content = blocks(entry).flatMap((b): Block[] => {
      if (b.type === "text") return [{ type: "text", text: head(b.text ?? "") }];
      if (b.type === "tool_use") {
        const path = str(b.input?.file_path);
        const type = str(b.input?.subagent_type);
        return [
          {
            type: "tool_use",
            ...(b.id === undefined ? {} : { id: b.id }),
            ...(b.name === undefined ? {} : { name: b.name }),
            label: labelOf(b),
            input: {
              ...(path === undefined ? {} : { file_path: path }),
              ...(type === undefined ? {} : { subagent_type: type }),
            },
          },
        ];
      }
      if (b.type === "tool_result") {
        return [
          {
            type: "tool_result",
            ...(b.tool_use_id === undefined ? {} : { tool_use_id: b.tool_use_id }),
            size: resultSize(b),
            images: resultImages(b),
          },
        ];
      }
      return [];
    });
  }
  return {
    ...(entry.type === undefined ? {} : { type: entry.type }),
    ...(entry.subtype === undefined ? {} : { subtype: entry.subtype }),
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.uuid === undefined ? {} : { uuid: entry.uuid }),
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    ...(entry.isSidechain ? { isSidechain: true } : {}),
    ...(entry.isMeta ? { isMeta: true } : {}),
    ...(entry.isCompactSummary ? { isCompactSummary: true } : {}),
    ...(entry.origin?.kind === undefined ? {} : { origin: { kind: entry.origin.kind } }),
    ...(message
      ? {
          message: {
            ...(message.id === undefined ? {} : { id: message.id }),
            ...(message.role === undefined ? {} : { role: message.role }),
            ...(message.model === undefined ? {} : { model: message.model }),
            ...(message.usage === undefined ? {} : { usage: message.usage }),
            content,
          },
        }
      : {}),
  };
};

/**
 * Calls `each` with every line of `path`, read a megabyte at a time, so a transcript of any size
 * never sits in memory as one string.
 */
const forEachLine = (path: string, each: (line: string) => void): void => {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(1 << 20);
    let rest = "";
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const lines = (rest + decoder.write(buffer.subarray(0, read))).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) each(line);
    }
    each(rest + decoder.end());
  } finally {
    closeSync(fd);
  }
};

/** The lines of a transcript that parse, slimmed. A line that isn't JSON is skipped. */
const readLines = (path: string): Entry[] => {
  const entries: Entry[] = [];
  forEachLine(path, (line) => {
    if (!line) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(slim(parsed));
    } catch {
      // Claude Code can leave a line half written.
    }
  });
  return entries;
};

interface Session {
  id: string;
  main: Entry[];
  subEntries: Entry[];
}

/**
 * One session's numbers for the runs that `selected` picks by their start. A compaction between runs
 * belongs to the run it prepares, and a subagent's calls to the run they happen in.
 */
const summarise = (
  { id, main, subEntries }: Session,
  segment: string,
  selected: (time: number) => boolean,
  inWindow: (time: number) => boolean,
  addUsage: (sum: UsageSum, usage: Usage, model: string) => void,
): SessionRow => {
  const cwd = main.find((e) => e.cwd)?.cwd ?? "";
  const toolLabel = new Map<string, string>();
  const tools: Record<string, number> = {};
  const outputs: Record<string, Output> = {};
  const reads = new Map<string, number>();
  const skills = new Map<string, number>();
  const agentTypes: Record<string, number> = {};
  const runs: { start: string; calls: Entry[] }[] = [];
  const runStarts: { time: number; picked: boolean }[] = [];
  let run: { start: string; calls: Entry[] } | null = null;
  let compactions = 0;
  let pending = 0;
  let inOtherSegment = false;
  for (const e of main) {
    const t = ms(e);
    if (e.type === "system" && e.subtype === "compact_boundary") {
      if (run) compactions++;
      // One during a run in another segment is that run's.
      else if (inWindow(t) && !inOtherSegment) pending++;
    }
    if (isRunStart(e)) {
      const picked = selected(t);
      inOtherSegment = !picked && inWindow(t);
      runStarts.push({ time: t, picked });
      run = picked ? { start: e.timestamp ?? "", calls: [] } : null;
      if (run) {
        runs.push(run);
        compactions += pending;
      }
      pending = 0;
      continue;
    }
    if (!run) continue;
    for (const b of blocks(e)) {
      if (b.type === "tool_use") {
        const label = labelOf(b);
        toolLabel.set(b.id ?? "", label);
        tools[label] = (tools[label] ?? 0) + 1;
        const path = str(b.input?.file_path);
        if (b.name === "Read" && path) reads.set(path, (reads.get(path) ?? 0) + 1);
        if (b.name === "Skill") {
          const name = label.slice("Skill ".length);
          skills.set(name, (skills.get(name) ?? 0) + 1);
        }
        if (b.name === "Agent" || b.name === "Task") {
          const type = str(b.input?.subagent_type) ?? "(no type)";
          agentTypes[type] = (agentTypes[type] ?? 0) + 1;
        }
      }
      if (b.type === "tool_result") {
        const label = toolLabel.get(b.tool_use_id ?? "") ?? "?";
        const o = (outputs[label] ??= { count: 0, chars: 0, max: 0, images: 0 });
        const size = resultSize(b);
        o.count++;
        o.chars += size;
        o.max = Math.max(o.max, size);
        o.images += resultImages(b);
      }
    }
    if (e.type === "assistant") run.calls.push(e);
  }
  const usage = blank();
  const runRows = runs.map((r) => {
    const calls = callsOf(r.calls);
    for (const c of calls) addUsage(usage, c.usage, c.model);
    const first = calls[0];
    return {
      start: r.start,
      calls: calls.length,
      contextAtStart: first ? contextOf(first.usage) : null,
      contextPeak: calls.length ? Math.max(...calls.map((c) => contextOf(c.usage))) : null,
    };
  });
  // A subagent's line belongs to the run that started last before it, from the first picked run on.
  const firstStart = runs[0] ? Date.parse(runs[0].start) : Infinity;
  const starts = runStarts.toSorted((a, b) => a.time - b.time);
  const runPicked = (t: number): boolean => starts.findLast((s) => s.time <= t)?.picked ?? false;
  const subUsage = blank();
  const subCalls = callsOf(subEntries.filter((e) => ms(e) >= firstStart && runPicked(ms(e))));
  for (const c of subCalls) addUsage(subUsage, c.usage, c.model);
  let repeatReads = 0;
  let agentsMdReads = 0;
  for (const [path, n] of reads) {
    repeatReads += n - 1;
    // Every read counts, not only the repeats: the metric is how often a run reads it.
    if (basename(path) === "AGENTS.md") agentsMdReads += n;
  }
  return {
    session: id,
    segment,
    issue: issueOf(cwd),
    // A session loads its skills once and keeps them across runs, so the seat comes from every
    // skill it ever loaded, not only those in the window.
    seat: seatOf(
      cwd,
      new Set(
        main.flatMap((e) =>
          blocks(e)
            .filter((b) => b.type === "tool_use" && b.name === "Skill")
            .map((b) => labelOf(b).slice("Skill ".length)),
        ),
      ),
    ),
    runs: runRows,
    compactions,
    usage,
    subagents: {
      calls: subCalls.length,
      models: [...new Set(subCalls.map((c) => c.model))],
      usage: subUsage,
    },
    agentTypes,
    tools,
    outputs,
    repeatReads,
    agentsMdReads,
    skillLoads: Object.fromEntries(skills),
  };
};

/** The metrics of one segment's sessions. */
const metricsOf = (segment: string, rows: readonly SessionRow[]): MetricResult[] => {
  const results: MetricResult[] = [];
  const add = (id: string, x: number, slice?: Record<string, string>) =>
    results.push({ id, segment, value: value(x), ...(slice ? { by: slice } : {}) });
  add("sessions", rows.length);
  add("session-runs", sum(rows.map((s) => s.runs.length)));
  const bySeat = new Map<string, SessionRow[]>();
  for (const s of rows) bySeat.set(s.seat, [...(bySeat.get(s.seat) ?? []), s]);
  for (const [seat, group] of bySeat) {
    const by = { seat };
    const runs = group.flatMap((s) => s.runs);
    const calls = sorted(runs.map((r) => r.calls));
    const start = sorted(runs.map((r) => r.contextAtStart));
    const w1 = sum(group.map((s) => s.usage.write1h + s.subagents.usage.write1h));
    const w5 = sum(group.map((s) => s.usage.write5m + s.subagents.usage.write5m));
    const own = sum(group.map((s) => s.usage.cost));
    const sub = sum(group.map((s) => s.subagents.usage.cost));
    const perRun = Math.max(1, runs.length);
    add("session-runs", runs.length, by);
    add("calls-per-run-p50", pct(calls, 0.5), by);
    add("calls-per-run-p90", pct(calls, 0.9), by);
    add("context-at-start-p50", pct(start, 0.5), by);
    add("context-at-start-p90", pct(start, 0.9), by);
    add("context-peak", Math.max(0, ...runs.map((r) => r.contextPeak ?? 0)), by);
    add("compactions", sum(group.map((s) => s.compactions)), by);
    add("cache-write-1h-share", w1 + w5 > 0 ? w1 / (w1 + w5) : Number.NaN, by);
    add("session-cost", own + sub, by);
    add("subagent-cost-share", own + sub > 0 ? sub / (own + sub) : Number.NaN, by);
    add("forks", sum(group.map((s) => s.agentTypes.fork ?? 0)), by);
    add("agents-md-reads-per-run", sum(group.map((s) => s.agentsMdReads)) / perRun, by);
    add("skill-loads-per-run", sum(group.flatMap((s) => Object.values(s.skillLoads))) / perRun, by);
  }
  const outputs = new Map<string, Output>();
  for (const s of rows) {
    for (const [label, o] of Object.entries(s.outputs)) {
      const t = outputs.get(label) ?? { count: 0, chars: 0, max: 0, images: 0 };
      outputs.set(label, {
        count: t.count + o.count,
        chars: t.chars + o.chars,
        max: Math.max(t.max, o.max),
        images: t.images + o.images,
      });
    }
  }
  for (const [tool, o] of [...outputs].toSorted((a, b) => b[1].chars - a[1].chars)) {
    const by = { tool };
    add("tool-output-calls", o.count, by);
    add("tool-output-tokens", o.chars / 4, by);
    add("tool-output-tokens-per-call", o.chars / 4 / o.count, by);
    add("tool-output-largest", o.max / 4, by);
    add("tool-output-images", o.images, by);
  }
  return results;
};

export interface ClaudeCodeOptions {
  /** The environment to read `CLAUDE_CONFIG_DIR` and `HOME` from. The default is `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Claude Code's projects folder: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export const claudeProjectsDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");

/**
 * Calls `each` with every session in `projects` that has a line in the window, one at a time, from
 * the folders `runFolders` picks. A transcript last written before the window can't have a line in
 * it, so it isn't read.
 */
const forEachSession = (
  projects: string,
  since: number,
  until: number,
  runFolders: RegExp | undefined,
  each: (session: Session) => void,
): void => {
  for (const project of readdirSync(projects).toSorted()) {
    if (runFolders && !runFolders.test(project)) continue;
    const dir = join(projects, project);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files.toSorted()) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < since) continue;
      } catch {
        continue;
      }
      const id = file.slice(0, -".jsonl".length);
      const all = readLines(path);
      if (!all.some((e) => ms(e) >= since && ms(e) < until)) continue;
      // Subagents: their own files under the session's folder (workflow agents one level deeper),
      // or sidechain lines in the session itself.
      const subDir = join(dir, id, "subagents");
      const subEntries = [
        ...all.filter((e) => e.isSidechain),
        ...(existsSync(subDir)
          ? readdirSync(subDir, { recursive: true })
              .map(String)
              .filter((f) => f.endsWith(".jsonl"))
              .toSorted()
              .flatMap((f) => readLines(join(subDir, f)))
          : []),
      ];
      each({ id, main: all.filter((e) => !e.isSidechain), subEntries });
    }
  }
};

/** The Claude Code collector, reading the projects folder `options.env` names. */
export const claudeCodeCollector = (options: ClaudeCodeOptions = {}): Collector => ({
  id: "claude-code",
  metrics: CLAUDE_CODE_METRICS,
  collect: (query: BenchQuery & { runFolders?: RegExp }): Promise<BenchResult> => {
    const projects = claudeProjectsDir(options.env ?? process.env);
    if (!existsSync(projects)) {
      return Promise.resolve({
        metrics: [],
        notes: [`No Claude Code projects folder at ${projects}, so the context metrics are n/a.`],
      });
    }
    const unpriced = new Set<string>();
    const addUsage = (total: UsageSum, usage: Usage, model: string): void => {
      const key = Object.keys(TRANSCRIPT_PRICES).find((k) => model.includes(k));
      if (!key) unpriced.add(model || "unnamed");
      const p = TRANSCRIPT_PRICES[key ?? FALLBACK_MODEL] ?? { input: 0, output: 0, cacheRead: 0 };
      const write = usage.cache_creation_input_tokens ?? 0;
      const split = usage.cache_creation ?? {};
      // Without a split, the write is counted as five-minute, the lower price.
      const write1h = split.ephemeral_1h_input_tokens ?? 0;
      const write5m = split.ephemeral_5m_input_tokens ?? write - write1h;
      total.input += usage.input_tokens ?? 0;
      total.output += usage.output_tokens ?? 0;
      total.cacheRead += usage.cache_read_input_tokens ?? 0;
      total.write5m += write5m;
      total.write1h += write1h;
      total.cost +=
        ((usage.input_tokens ?? 0) * p.input +
          (usage.output_tokens ?? 0) * p.output +
          (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
          write5m * p.input * 1.25 +
          write1h * p.input * 2) /
        1e6;
    };
    const { since, until, split } = query;
    const inWindow = (t: number) => t >= since && t < until;
    const bySegment = new Map(split.segments.map((segment) => [segment, [] as SessionRow[]]));
    // One session at a time, reduced to its rows before the next is read.
    forEachSession(projects, since, until, query.runFolders, (session) => {
      const anyRun = session.main.some((e) => isRunStart(e) && inWindow(ms(e)));
      const first = session.main.find((e) => inWindow(ms(e)));
      for (const segment of split.segments) {
        const selected = (t: number) => inWindow(t) && split.segmentOf(t) === segment;
        const row = summarise(session, segment, selected, inWindow, addUsage);
        // A session whose runs all fall in another segment belongs there. One with no run in the
        // window at all goes where its first line in the window does.
        const belongs =
          row.runs.length > 0 ||
          (!anyRun && first !== undefined && split.segmentOf(ms(first)) === segment);
        if (belongs) bySegment.get(segment)?.push(row);
      }
    });
    const rows: SessionRow[] = [];
    const metrics: MetricResult[] = [];
    for (const [segment, segmentRows] of bySegment) {
      rows.push(...segmentRows);
      metrics.push(...metricsOf(segment, segmentRows));
    }
    return Promise.resolve({
      metrics,
      rows: { sessions: rows },
      notes: unpriced.size > 0 ? [`Priced as Opus 5.5: ${[...unpriced].join(", ")}.`] : [],
    });
  },
});
