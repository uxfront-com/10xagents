// The contract every connector implements. A connector maps the neutral model onto one platform.

import type { RenderedSetup, RenderedTarget } from "./render.ts";
import type { Workflow } from "./schema.ts";

/** A metric's id in the shared catalogue, like `pass-rate`. */
export type MetricId = string;

/** What a connector can do on its platform. Where it can't, the CLI falls back. */
export interface Capabilities {
  /** The platform holds one context that every agent reads, so global traits go there once. */
  sharedContext: boolean;
  /** An issue picks its own workflow, rather than its project's. */
  workflowPerIssue: boolean;
  /** The platform has squads, with a leader and member roles. */
  squads: boolean;
  /** The platform attaches skills to agents. */
  skills: boolean;
  /** The metrics `bench` can report. Any other metric shows as `n/a`. */
  metrics: MetricId[];
}

/** The platform's state for one target, as `pull` reads it. Its shape is the connector's own. */
export type LiveState = Record<string, unknown>;

/** One difference between the live state and the rendered setup. */
export interface Change {
  /** What changes, like `agent`, `skill`, `squad`, `workflow` or `context`. */
  kind: string;
  /** The changed item's id or name. */
  id: string;
  /** One line that says what the change does. */
  summary: string;
  /** A unified diff of the text that changes, when there is one. */
  diff?: string;
  /** Only a person can make this change, so the CLI prints it with `!` and exits 1. */
  manual?: boolean;
  /**
   * Only something to know, like a project the sync leaves alone. The CLI prints it with `·`,
   * and `apply` never gets it.
   */
  note?: boolean;
  /** What `apply` needs to make the change. Only the connector reads it. */
  data?: unknown;
}

/** How `pull` reaches the platform: the account and the place the CLI was asked for. */
export interface PullOptions {
  /** The platform profile or account to use, from `--profile`. */
  profile?: string;
  /** The workspace to use instead of the target's, from `--workspace`. */
  workspace?: string;
  /** Asks the person running the CLI. Missing when there's no terminal to ask in. */
  ask?: (question: string) => Promise<string>;
  /** Prints a line, like the profile and workspace `pull` chose. */
  log?: (line: string) => void;
}

/** Where a `pull` read from. */
export interface Place {
  /** Its name, like a workspace's, for the person confirming changes to it. */
  name: string;
  /** The options that read the same place again, through the same account, without asking. */
  pull: PullOptions;
}

/** What `apply` couldn't do. The others went through. */
export interface ApplyResult {
  failed: { change: Change; message: string }[];
}

/** A problem a connector finds in a rendered setup, which the platform would refuse. */
export interface ConnectorIssue {
  /** The file at fault. The default is the target's `target.yaml`. */
  file?: string;
  field: string;
  message: string;
}

/** The only fields of a target that `bench` reads. */
export interface BenchTarget {
  id: string;
  /** The platform's workspace: the target's `workspace`, or its `id`. */
  workspace: string;
  connector: string;
}

/**
 * How `bench` splits what it measures into segments: one, `all`; `before`, `across` and `after`
 * a cutover; or one per setup hash with `--compare`.
 */
export interface BenchSplit {
  /** The segments, in the order `bench` prints them. */
  segments: string[];
  /** The `--cutover` moment, in milliseconds since the epoch. */
  cutover?: number;
  /**
   * The segment of a run, session or event that started at `time`, in milliseconds since the
   * epoch. `undefined` leaves it out, like a run before the first sync under `--compare`.
   */
  segmentOf(time: number): string | undefined;
  /**
   * The segment of a request whose first run started at `start`, and the moment it's judged at.
   * `isOpenAt(t)` says whether the request was still open at `t`. Under a cutover, a request that
   * started before it and was still open there goes to `across`, judged at `--until`.
   */
  placeRequest(
    start: number,
    isOpenAt: (time: number) => boolean,
  ): { segment: string; horizon: number } | undefined;
}

/** The window, the split and the workflow steps that `bench` measures. */
export interface BenchQuery {
  target: BenchTarget;
  /** The window's start and end, in milliseconds since the epoch. */
  since: number;
  until: number;
  split: BenchSplit;
  /** The status keys of the steps where reviewers review delivered work. */
  reviewSteps: string[];
  /** The status keys of the steps where reviewers review plans. */
  planSteps: string[];
  /** The platform profile or account to use, from `--profile`. */
  profile?: string;
  /** Asks the person running the CLI. Missing when there's no terminal to ask in. */
  ask?: (question: string) => Promise<string>;
  /** Prints a progress line. */
  log?: (line: string) => void;
}

/**
 * One metric's value in one segment. `null` means it can't be measured, and shows as `n/a`. `by`
 * names the slice a value is for, like `{ seat: "QA" }`.
 */
export interface MetricResult {
  id: MetricId;
  value: number | null;
  unit?: string;
  segment?: string;
  by?: Record<string, string>;
}

/** What a connector's `bench` or a collector reports. */
export interface BenchResult {
  metrics: MetricResult[];
  /**
   * The values per row, like per request, run or session, by table name. Counts, times and costs
   * only: no titles or comment text.
   */
  rows?: Record<string, unknown[]>;
  /** Lines to show beside the metrics, like requests left out and why. */
  notes?: string[];
}

/** Measures what a platform's records can't show, like the Claude Code transcripts. */
export interface Collector {
  id: string;
  /** The metrics it reports. */
  metrics: MetricId[];
  collect(query: BenchQuery & { runFolders?: RegExp }): Promise<BenchResult>;
}

/** The platform name of every column, by workflow id, then column key. */
export type ColumnNames = Record<string, Record<string, string>>;

export interface Connector {
  id: string;
  capabilities: Capabilities;
  /** Reads the platform's state for `target`. Throws when the platform can't be read. */
  pull(target: RenderedTarget, options?: PullOptions): Promise<LiveState>;
  /** Where `live` was read from. Without it, the CLI names the target's workspace. */
  place?(live: LiveState): Place;
  /** What differs, as changes to apply, `manual` changes for a person and `note`s. */
  plan(rendered: RenderedSetup, live: LiveState): Promise<Change[]>;
  /** Makes `changes`, in order. A change that fails doesn't stop the others. */
  apply(changes: Change[]): Promise<ApplyResult | void>;
  /** The problems in `rendered` that the platform would refuse, checked before `pull`. */
  validate?(rendered: RenderedSetup): ConnectorIssue[];
  /** Measures `capabilities.metrics` on the platform's records. */
  bench?(query: BenchQuery): Promise<BenchResult>;
  /**
   * The Claude Code project folders that hold the platform's agent runs. The Claude Code collector
   * reads only these; without it, it reads every project.
   */
  runFolders?: RegExp;
  /**
   * The platform name of each column of a target's workflows, given in the target's order.
   * `{{workflows.<id>.columns.<key>}}` renders it. Without it, a column's name is its `name`,
   * or its key.
   */
  columnNames?(workflows: readonly Workflow[]): ColumnNames;
}
