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
export { BUILT_IN_TEMPLATES } from "./default-template.ts";
export { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
export type { Diagnostic } from "./diagnostics.ts";
export { loadSetup } from "./loader.ts";
export type {
  GlobalTrait,
  LoadedAgent,
  LoadedTarget,
  LoadedWorkflow,
  Param,
  Setup,
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
export { validateSetup } from "./validate.ts";
