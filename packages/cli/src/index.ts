// The `10xagents` library: the model, the renderer and the connector contract.

export type {
  ApplyResult,
  BenchQuery,
  BenchResult,
  BenchSplit,
  BenchTarget,
  Capabilities,
  Collector,
  Change,
  ColumnNames,
  Connector,
  ConnectorIssue,
  LiveState,
  MetricId,
  MetricResult,
  Place,
  PullOptions,
} from "./contract.ts";
export {
  CLAUDE_CODE_METRICS,
  claudeCodeCollector,
  claudeProjectsDir,
} from "./bench/claude-code.ts";
export type { ClaudeCodeOptions, SessionRow } from "./bench/claude-code.ts";
export { METRICS, metricDefinition } from "./bench/catalogue.ts";
export type { MetricDefinition, MetricGroup, MetricUnit } from "./bench/catalogue.ts";
export { BenchError, formatReport, readBenchTarget, runBench } from "./bench/run.ts";
export type { BenchDeps, BenchOptions, BenchReport, ReportMetric } from "./bench/run.ts";
export { compareSplit, cutoverSplit, parseMoment, wholeSplit } from "./bench/split.ts";
export {
  appendSyncLog,
  hashAt,
  matchHash,
  readSyncLog,
  setupHash,
  SYNC_LOG,
  SyncLogError,
} from "./bench/sync-log.ts";
export type { SyncLogEntry } from "./bench/sync-log.ts";
export { buildFiles, writeFiles } from "./build.ts";
export { defineConfig, loadConfig, readLock } from "./config.ts";
export type { Config, ConfigInput, Lock, LockEntry } from "./config.ts";
export { BUILT_IN_TEMPLATES } from "./default-template.ts";
export { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
export type { Diagnostic } from "./diagnostics.ts";
export { fetchSource, githubFetcher, hashDir } from "./fetch.ts";
export type { Fetcher, GitHubFetcherOptions } from "./fetch.ts";
export { initSetup, installSetup } from "./install.ts";
export { openSetup, resolveLayers } from "./layers.ts";
export type { LockMode, Opened, OpenedLayer, Resolution, SourceOptions } from "./layers.ts";
export { loadLayer, loadSetup, mergeLayers } from "./loader.ts";
export { createMain, runCli } from "./main.ts";
export type { CliContext } from "./main.ts";
export type {
  GlobalTrait,
  Layer,
  LoadedAgent,
  LoadedTarget,
  LoadedWorkflow,
  Param,
  Setup,
  Skill,
  SourceText,
  Template,
  Trait,
} from "./loader.ts";
export { ConnectorError, connectorPackage, findConnectors, loadConnector } from "./registry.ts";
export type { RegistryOptions } from "./registry.ts";
export { defaultColumnNames, renderTarget } from "./render.ts";
export type {
  RenderedAgent,
  RenderedColumn,
  RenderedSetup,
  RenderedSkill,
  RenderedSquad,
  RenderedTarget,
  RenderedWorkflow,
  RenderOptions,
} from "./render.ts";
export { MAX_DESCRIPTION } from "./schema.ts";
export type { Agent, Column, Override, Scalar, Target, TraitRef, Workflow } from "./schema.ts";
export { formatSource, parseSource, SourceError } from "./source.ts";
export type { BundledSource, GitHubSource, LocalSource, Source } from "./source.ts";
export { validateSetup } from "./validate.ts";
