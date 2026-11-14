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

/** The window and setups that `bench` measures. */
export interface BenchQuery {
  target: RenderedTarget;
  since?: string;
  until?: string;
}

/** One metric's value. `null` means the connector can't measure it, and shows as `n/a`. */
export interface MetricResult {
  id: MetricId;
  value: number | null;
  unit?: string;
}

/** The platform name of every column, by workflow id, then column key. */
export type ColumnNames = Record<string, Record<string, string>>;

export interface Connector {
  id: string;
  capabilities: Capabilities;
  /** Reads the platform's state for `target`. Throws when the platform can't be read. */
  pull(target: RenderedTarget, options?: PullOptions): Promise<LiveState>;
  /** What differs, as changes to apply, `manual` changes for a person and `note`s. */
  plan(rendered: RenderedSetup, live: LiveState): Promise<Change[]>;
  /** Makes `changes`, in order. A change that fails doesn't stop the others. */
  apply(changes: Change[]): Promise<ApplyResult | void>;
  /** The problems in `rendered` that the platform would refuse, checked before `pull`. */
  validate?(rendered: RenderedSetup): ConnectorIssue[];
  bench?(query: BenchQuery): Promise<MetricResult[]>;
  /**
   * The platform name of each column of a target's workflows, given in the target's order.
   * `{{workflows.<id>.columns.<key>}}` renders it. Without it, a column's name is its `name`,
   * or its key.
   */
  columnNames?(workflows: readonly Workflow[]): ColumnNames;
}
