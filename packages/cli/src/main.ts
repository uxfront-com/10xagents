import { relative, resolve, sep } from "node:path";

import { defineCommand } from "citty";
import type { CommandDef } from "citty";

import pkg from "../package.json" with { type: "json" };
import { buildFiles, writeFiles } from "./build.ts";
import type { Config } from "./config.ts";
import type { Capabilities } from "./contract.ts";
import { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
import { defaultCacheDir, githubFetcher } from "./fetch.ts";
import { initSetup, installSetup } from "./install.ts";
import { defaultBundledDir, openSetup } from "./layers.ts";
import type { SourceOptions } from "./layers.ts";
import type { Setup } from "./loader.ts";
import { ConnectorError, findConnectors, loadConnector } from "./registry.ts";
import { renderTarget } from "./render.ts";
import { validateSetup } from "./validate.ts";

/** What the commands reach outside the setup. Tests pass their own. */
export interface CliContext {
  cwd: () => string;
  loadConnector: typeof loadConnector;
  findConnectors: typeof findConnectors;
  /** How sources are fetched and cached, and where the bundled setups are. */
  sources: () => SourceOptions;
}

const dirArg = {
  type: "string",
  description:
    "The setup: a folder, a bundled setup's name, or github:<owner>/<repo>[/<subdir>][#<ref>]",
  default: ".10xagents",
} as const;
const targetArg = { type: "string", description: "The target's slug" } as const;

/** Prints a line to standard output. */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const fail = (lines: readonly string[]): void => {
  for (const line of lines) console.error(line);
  process.exitCode = 1;
};

/**
 * Prints each diagnostic, and exits 1. A file in a fetched folder shows as its source at its commit,
 * from `labels`, rather than as a path into the cache.
 */
const printDiagnostics = (
  diagnostics: Diagnostics,
  cwd: string,
  labels: ReadonlyMap<string, string> = new Map(),
): void => {
  const count = diagnostics.size;
  const label = (file: string): string => {
    for (const [dir, source] of labels) {
      if (file === dir) return source;
      if (file.startsWith(`${dir}${sep}`))
        return `${source}/${file
          .slice(dir.length + 1)
          .split(sep)
          .join("/")}`;
    }
    return file;
  };
  fail([
    ...diagnostics.list.map((diagnostic) =>
      formatDiagnostic({ ...diagnostic, file: label(diagnostic.file) }, cwd),
    ),
    `${count} ${count === 1 ? "error" : "errors"}.`,
  ]);
};

/** The `--target` given, the config's `target`, or the setup's only target. */
const pickTarget = (
  setup: Setup,
  config: Config,
  given: string | undefined,
): string | undefined => {
  if (given !== undefined) return given;
  if (config.target !== undefined) return config.target;
  const slugs = [...setup.targets.keys()];
  if (slugs.length === 1) return slugs[0];
  fail([
    slugs.length === 0
      ? "The setup has no targets: add targets/<slug>/target.yaml."
      : `Choose a target with --target: ${slugs.join(", ")}.`,
  ]);
  return undefined;
};

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const describeCapabilities = (capabilities: Capabilities): string =>
  [
    `sharedContext: ${yesNo(capabilities.sharedContext)}`,
    `workflowPerIssue: ${yesNo(capabilities.workflowPerIssue)}`,
    `squads: ${yesNo(capabilities.squads)}`,
    `skills: ${yesNo(capabilities.skills)}`,
    `metrics: ${capabilities.metrics.length > 0 ? capabilities.metrics.join(", ") : "none"}`,
  ].join(", ");

/** A command that a later release adds. It exits 1. */
const notYet = (name: string, description: string): CommandDef =>
  defineCommand({
    meta: { name, description },
    run: () => fail([`10xagents ${name} is not available yet.`]),
  });

export const createMain = (context: Partial<CliContext> = {}): CommandDef => {
  const ctx: CliContext = {
    cwd: () => process.cwd(),
    loadConnector,
    findConnectors,
    sources: () => ({
      fetcher: githubFetcher(),
      cacheDir: defaultCacheDir(),
      bundledDir: defaultBundledDir(),
    }),
    ...context,
  };

  /** Source options that print each source resolved now, and label fetched files in messages. */
  const sourceOptions = (labels: Map<string, string>): SourceOptions => ({
    ...ctx.sources(),
    onResolve: (source, sha) => console.error(`Resolved ${source} to ${sha}.`),
    labels,
  });

  const validate = defineCommand({
    meta: {
      name: "validate",
      description:
        "Check the schemas, every reference (traits, params, vars, workflows, slots, templates) and the workflow graph",
    },
    args: { dir: dirArg, target: { ...targetArg, description: "Check only this target" } },
    run: async ({ args }) => {
      const cwd = ctx.cwd();
      const diagnostics = new Diagnostics();
      const labels = new Map<string, string>();
      const opened = await openSetup(args.dir, cwd, sourceOptions(labels), diagnostics);
      if (!opened) return printDiagnostics(diagnostics, cwd, labels);
      const { setup } = opened;
      validateSetup(setup, diagnostics, args.target === undefined ? {} : { target: args.target });
      if (diagnostics.size > 0) return printDiagnostics(diagnostics, cwd, labels);
      const targets = args.target === undefined ? setup.targets.size : 1;
      say(
        `Valid: ${setup.agents.size} agents, ${setup.workflows.size} workflows, ${targets} ${targets === 1 ? "target" : "targets"}.`,
      );
    },
  });

  const build = defineCommand({
    meta: {
      name: "build",
      description: "Render every prompt, workflow and shared context of a target to a directory",
    },
    args: {
      dir: dirArg,
      target: targetArg,
      out: { type: "string", description: "Where to write the files", default: "dist" },
    },
    run: async ({ args }) => {
      const cwd = ctx.cwd();
      const diagnostics = new Diagnostics();
      const labels = new Map<string, string>();
      const opened = await openSetup(args.dir, cwd, sourceOptions(labels), diagnostics);
      if (!opened) return printDiagnostics(diagnostics, cwd, labels);
      const { setup } = opened;
      const slug = pickTarget(setup, opened.config, args.target);
      if (slug === undefined) return;
      validateSetup(setup, diagnostics, { target: slug });
      if (diagnostics.size > 0) return printDiagnostics(diagnostics, cwd, labels);
      const target = setup.targets.get(slug);
      if (!target) return;
      let connector;
      try {
        connector = await ctx.loadConnector(target.target.connector, { cwd });
      } catch (error) {
        if (error instanceof ConnectorError) return fail([error.message]);
        throw error;
      }
      const rendered = renderTarget(setup, slug, diagnostics, {
        sharedContext: connector.capabilities.sharedContext,
        ...(connector.columnNames ? { columnNames: connector.columnNames.bind(connector) } : {}),
      });
      if (!rendered || diagnostics.size > 0) return printDiagnostics(diagnostics, cwd, labels);
      const out = resolve(cwd, args.out);
      if (out === setup.dir) {
        return fail(["--out must not be the setup's own directory: its files would mix."]);
      }
      writeFiles(out, buildFiles(rendered));
      say(
        `Built target ${slug}: ${rendered.agents.length} agents and ${rendered.workflows.length} workflows in ${out}.`,
      );
    },
  });

  const install = defineCommand({
    meta: {
      name: "install",
      description:
        "Pin every remote source to a commit in 10xagents.lock. --update moves each to its latest ref",
    },
    args: {
      dir: { ...dirArg, description: "The setup's folder" },
      update: { type: "boolean", description: "Move every source to its ref's latest commit" },
    },
    run: async ({ args }) => {
      const cwd = ctx.cwd();
      const diagnostics = new Diagnostics();
      const labels = new Map<string, string>();
      const installed = await installSetup(
        args.dir,
        cwd,
        args.update === true,
        { ...ctx.sources(), labels },
        diagnostics,
      );
      if (!installed) return printDiagnostics(diagnostics, cwd, labels);
      for (const [source, { sha }] of installed.lock) say(`${source} → ${sha}`);
      const count = installed.lock.size;
      say(
        `${installed.changed ? "Wrote" : "Kept"} 10xagents.lock: ${count} remote ${count === 1 ? "source" : "sources"}.`,
      );
    },
  });

  const init = defineCommand({
    meta: {
      name: "init",
      description:
        "Write .10xagents/10xagents.config.ts extending a source, plus a starter target, then install",
    },
    args: {
      dir: { ...dirArg, description: "The new setup's folder" },
      from: {
        type: "string",
        description: "The setup to extend: a folder, a bundled setup's name, or github:…",
        default: "ultracode",
      },
      target: {
        type: "string",
        description: "The starter target's slug. The default is the current folder's name",
      },
    },
    run: async ({ args }) => {
      const cwd = ctx.cwd();
      const diagnostics = new Diagnostics();
      const labels = new Map<string, string>();
      const initialized = await initSetup(
        args.dir,
        args.from,
        args.target,
        cwd,
        sourceOptions(labels),
        diagnostics,
      );
      if (!initialized) return printDiagnostics(diagnostics, cwd, labels);
      for (const file of initialized.files) say(`Wrote ${relative(cwd, file) || file}.`);
      say(
        `The setup extends ${initialized.from}, with the starter target ${initialized.target}. Run 10xagents validate next.`,
      );
    },
  });

  const connectors = defineCommand({
    meta: { name: "connectors", description: "List the connectors and each one's capabilities" },
    run: async () => {
      const cwd = ctx.cwd();
      const ids = ctx.findConnectors(cwd);
      if (ids.length === 0) {
        say("No connectors installed. Install one, like @10xagents/connector-multica.");
        return;
      }
      for (const id of ids) {
        try {
          const connector = await ctx.loadConnector(id, { cwd });
          say(`${id}: ${describeCapabilities(connector.capabilities)}`);
        } catch (error) {
          if (!(error instanceof ConnectorError)) throw error;
          fail([error.message]);
        }
      }
    },
  });

  return defineCommand({
    meta: {
      name: "10xagents",
      version: pkg.version,
      description: pkg.description,
    },
    subCommands: {
      init,
      install,
      validate,
      build,
      plan: notYet(
        "plan",
        "Show the connector's diff of the live state against the rendered setup",
      ),
      sync: notYet("sync", "Apply the diff after you confirm"),
      bench: notYet("bench", "Run every metric the connector and collectors support"),
      connectors,
    },
  });
};

export const main: CommandDef = createMain();
