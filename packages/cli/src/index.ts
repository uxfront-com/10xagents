// The `10xagents` library: the model, the renderer and the connector contract.

export type {
  BenchQuery,
  Capabilities,
  Change,
  ColumnNames,
  Connector,
  LiveState,
  MetricId,
  MetricResult,
} from "./contract.ts";
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
