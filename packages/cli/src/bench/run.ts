// `bench`: runs every metric the target's connector and the collectors support, over a window,
// and shows every other metric of the catalogue as `n/a`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import type {
  BenchQuery,
  BenchResult,
  BenchSplit,
  BenchTarget,
  Collector,
  Connector,
  MetricResult,
} from "../contract.ts";
import { BenchTargetSchema, check } from "../schema.ts";
import type { MetricGroup, MetricUnit } from "./catalogue.ts";
import { METRICS, metricDefinition } from "./catalogue.ts";
import { compareSplit, cutoverSplit, parseMoment, wholeSplit } from "./split.ts";
import { matchHash, readSyncLog, SYNC_LOG } from "./sync-log.ts";

export class BenchError extends Error {
  override name = "BenchError";
}

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * Reads `targets/<slug>/target.yaml` in the setup folder `dir`, and only its `id`, `workspace` and
 * `connector`: nothing else in the setup is read or checked. Without `slug`, the setup's only
 * target. Throws a `BenchError` when there's no such target or its fields are wrong.
 */
export const readBenchTarget = (dir: string, slug: string | undefined): BenchTarget => {
  if (!isDir(dir)) {
    throw new BenchError(
      `${dir}: bench reads a setup folder on this machine, and there's none here`,
    );
  }
  const targets = join(dir, "targets");
  let picked = slug;
  if (picked === undefined) {
    const slugs = isDir(targets)
      ? readdirSync(targets)
          .filter((name) => existsSync(join(targets, name, "target.yaml")))
          .toSorted()
      : [];
    if (slugs.length !== 1) {
      throw new BenchError(
        slugs.length === 0
          ? "The setup has no targets: add targets/<slug>/target.yaml."
          : `Choose a target with --target: ${slugs.join(", ")}.`,
      );
    }
    picked = slugs[0] ?? "";
  }
  const file = join(targets, picked, "target.yaml");
  if (!existsSync(file)) throw new BenchError(`${file}: no target ${picked}`);
  let data: unknown;
  try {
    data = parse(readFileSync(file, "utf8")) ?? {};
  } catch (error) {
    throw new BenchError(
      `${file}: not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { output, issues } = check(BenchTargetSchema, data);
  if (!output) {
    throw new BenchError(
      issues.map((issue) => `${file}: ${issue.field}: ${issue.message}`).join("\n"),
    );
  }
  return {
    id: output.id,
    workspace: output.workspace ?? output.id,
    connector: output.connector,
  };
};

export interface BenchOptions {
  /** The setup folder, absolute. `sync-log.jsonl` is read from it. */
  dir: string;
  target?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  cutover?: string | undefined;
  /** The two setup hashes, or unique prefixes of them, to compare. */
  compare?: readonly string[] | undefined;
  reviewSteps: readonly string[];
  planSteps: readonly string[];
  profile?: string | undefined;
  /** The moment `--since` and `--until` count days back from. */
  now: number;
  ask?: ((question: string) => Promise<string>) | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface BenchDeps {
  loadConnector: (id: string) => Promise<Connector>;
  collectors: readonly Collector[];
}

/** One metric's value in the report, with its catalogue entry and where it came from. */
export interface ReportMetric {
  id: string;
  group: MetricGroup;
  unit: MetricUnit;
  segment?: string;
  by?: Record<string, string>;
  value: number | null;
  /** The connector or collector that measured it, or `null` when none supports it. */
  source: string | null;
}

export interface BenchReport {
  target: string;
  connector: string;
  workspace: string;
  since: string;
  until: string;
  cutover: string | null;
  compare: string[] | null;
  segments: string[];
  metrics: ReportMetric[];
  /** Each source's per-row values, by table. */
  rows: Record<string, Record<string, unknown[]>>;
  notes: string[];
}

/** The window and split the options ask for. Throws a `BenchError` for a wrong flag. */
const windowOf = (
  options: BenchOptions,
  target: BenchTarget,
): { since: number; until: number; split: BenchSplit } => {
  const { now } = options;
  const since = parseMoment(options.since ?? "30", now);
  const until = options.until === undefined ? now : parseMoment(options.until, now);
  if (!(since < now)) {
    throw new BenchError(
      "--since takes a number of days, like 30, or a past date and time, like 2026-10-01T09:00",
    );
  }
  if (!(until > since)) {
    throw new BenchError("--until takes a moment after --since, like 2026-11-08T12:00");
  }
  if (options.cutover !== undefined && options.compare !== undefined) {
    throw new BenchError("Pass --cutover or --compare, not both.");
  }
  if (options.cutover !== undefined) {
    const cutover = /^\d+(\.\d+)?$/.test(options.cutover)
      ? Number.NaN
      : parseMoment(options.cutover, now);
    if (!Number.isFinite(cutover)) {
      throw new BenchError("--cutover takes a date and time, like 2026-11-08T12:00");
    }
    if (!(cutover > since && cutover < until)) {
      throw new BenchError(
        "--cutover takes a moment between --since and --until, like 2026-11-08T12:00",
      );
    }
    return { since, until, split: cutoverSplit(cutover, until) };
  }
  if (options.compare !== undefined) {
    if (options.compare.length !== 2) {
      throw new BenchError("--compare takes two setup hashes, like --compare 3f2a91c 8be04d1.");
    }
    let entries;
    try {
      entries = readSyncLog(options.dir);
    } catch (error) {
      throw new BenchError(error instanceof Error ? error.message : String(error));
    }
    if (entries.length === 0) {
      throw new BenchError(`--compare needs ${join(options.dir, SYNC_LOG)}, which sync writes.`);
    }
    // Only this target's syncs: one setup logs every target it syncs.
    const hashes = entries
      .filter((entry) => entry.target === target.id)
      .map((entry) => entry.setupHash);
    if (hashes.length === 0) {
      throw new BenchError(
        `--compare needs a sync of target ${target.id} in ${join(options.dir, SYNC_LOG)}, which has none.`,
      );
    }
    let picked: string[];
    try {
      picked = options.compare.map((given) => matchHash(given, hashes));
    } catch (error) {
      throw new BenchError(error instanceof Error ? error.message : String(error));
    }
    if (picked[0] === picked[1])
      throw new BenchError("--compare takes two different setup hashes.");
    return { since, until, split: compareSplit(target.id, entries, picked, until) };
  }
  return { since, until, split: wholeSplit(until) };
};

/** Runs the target's connector and every collector, and fills in `n/a` for the rest. */
export const runBench = async (options: BenchOptions, deps: BenchDeps): Promise<BenchReport> => {
  const target = readBenchTarget(options.dir, options.target);
  const { since, until, split } = windowOf(options, target);
  const connector = await deps.loadConnector(target.connector);
  const query: BenchQuery = {
    target,
    since,
    until,
    split,
    reviewSteps: [...options.reviewSteps],
    planSteps: [...options.planSteps],
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.ask ? { ask: options.ask } : {}),
    ...(options.log ? { log: options.log } : {}),
  };

  const sources: { id: string; metrics: Set<string>; result: BenchResult }[] = [];
  const connectorMetrics = connector.bench ? connector.capabilities.metrics : [];
  if (connector.bench && connectorMetrics.length > 0) {
    sources.push({
      id: connector.id,
      metrics: new Set(connectorMetrics),
      result: await connector.bench(query),
    });
  }
  for (const collector of deps.collectors) {
    if (collector.metrics.length === 0) continue;
    let result: BenchResult;
    // A collector that fails leaves its metrics n/a, and the connector's results stand.
    try {
      result = await collector.collect({
        ...query,
        ...(connector.runFolders ? { runFolders: connector.runFolders } : {}),
      });
    } catch (error) {
      result = {
        metrics: [],
        notes: [
          `The ${collector.id} collector failed, so its metrics are n/a: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    sources.push({ id: collector.id, metrics: new Set(collector.metrics), result });
  }

  const notes: string[] = [];
  const metrics: ReportMetric[] = [];
  for (const definition of METRICS) {
    const { id, group, unit } = definition;
    const source = sources.find((candidate) => candidate.metrics.has(id));
    const results: MetricResult[] =
      source?.result.metrics.filter((result) => result.id === id) ?? [];
    const entry = (result: MetricResult): ReportMetric => ({
      id,
      group,
      unit,
      ...(result.segment === undefined ? {} : { segment: result.segment }),
      ...(result.by ? { by: result.by } : {}),
      value:
        typeof result.value === "number" && Number.isFinite(result.value) ? result.value : null,
      source: source?.id ?? null,
    });
    // A value for no segment in particular, like the requests left out, holds for the window.
    const whole = results.filter((result) => result.segment === undefined);
    metrics.push(...whole.map(entry));
    for (const segment of split.segments) {
      const inSegment = results.filter((result) => result.segment === segment);
      if (inSegment.length === 0 && whole.length === 0) {
        metrics.push({ id, group, unit, segment, value: null, source: source?.id ?? null });
      }
      metrics.push(...inSegment.map(entry));
    }
  }
  const rows: Record<string, Record<string, unknown[]>> = {};
  for (const source of sources) {
    const unknown = [
      ...new Set(
        source.result.metrics.map((result) => result.id).filter((id) => !metricDefinition(id)),
      ),
    ];
    if (unknown.length > 0) {
      notes.push(
        `${source.id} reported metrics the catalogue doesn't know: ${unknown.join(", ")}.`,
      );
    }
    if (source.result.rows) rows[source.id] = source.result.rows;
    notes.push(...(source.result.notes ?? []));
  }
  return {
    target: target.id,
    connector: target.connector,
    workspace: target.workspace,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    cutover: split.cutover === undefined ? null : new Date(split.cutover).toISOString(),
    compare: options.compare === undefined ? null : [...split.segments],
    segments: [...split.segments],
    metrics,
    rows,
    notes,
  };
};

/** A value as the old scripts printed it, or `n/a`. */
export const formatValue = (unit: MetricUnit, x: number | null): string => {
  if (x === null) return "n/a";
  switch (unit) {
    case "hours":
      return x >= 48 ? `${(x / 24).toFixed(1)}d` : `${x.toFixed(1)}h`;
    case "minutes":
      return x >= 90 ? `${(x / 60).toFixed(1)}h` : `${x.toFixed(1)}m`;
    case "usd":
      return x >= 100 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`;
    case "ratio":
      return `${Math.round(100 * x)}%`;
    case "tokens":
      return `${Math.round(x / 1000)}k`;
    case "count":
      return Number.isInteger(x) ? String(x) : x.toFixed(2);
    default:
      return String(x);
  }
};

const GROUPS: Record<MetricGroup, string> = {
  outcome: "Outcome",
  review: "Review",
  "cost-time": "Cost and time",
  context: "Context",
};

const span = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** The report as text: one table per group, with a column per segment, then the notes. */
export const formatReport = (report: BenchReport): string[] => {
  const lines = [
    `Target ${report.target} (${report.connector}), ${span(report.since)} to ${span(report.until)} UTC`,
  ];
  if (report.cutover) lines.push(`Split at ${span(report.cutover)} UTC`);
  for (const [group, title] of Object.entries(GROUPS)) {
    const metrics = report.metrics.filter((metric) => metric.group === group);
    if (metrics.length === 0) continue;
    // One line per metric and slice, with each segment's value.
    const keyed = new Map<string, Map<string, string>>();
    for (const metric of metrics) {
      const slice = metric.by
        ? ` · ${Object.entries(metric.by)
            .map(([key, item]) => `${key} ${item}`)
            .join(", ")}`
        : "";
      const key = `${metric.id}${slice}`;
      const cells = keyed.get(key) ?? new Map<string, string>();
      cells.set(metric.segment ?? "", formatValue(metric.unit, metric.value));
      keyed.set(key, cells);
    }
    const headers = ["", ...report.segments];
    const body = [...keyed].map(([key, cells]) => [
      key,
      ...report.segments.map((segment) => cells.get(segment) ?? cells.get("") ?? "–"),
    ]);
    const widths = headers.map((head, i) =>
      Math.max(head.length, ...body.map((row) => (row[i] ?? "").length)),
    );
    const line = (cells: readonly string[]) =>
      cells
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd();
    lines.push("", title, line(headers), widths.map((w) => "-".repeat(w)).join("  "));
    lines.push(...body.map(line));
  }
  if (report.notes.length > 0) lines.push("", ...report.notes);
  return lines;
};
