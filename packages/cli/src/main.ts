import { resolve } from "node:path";

import { defineCommand } from "citty";
import type { CommandDef } from "citty";

import pkg from "../package.json" with { type: "json" };
import { buildFiles, writeFiles } from "./build.ts";
import type { Capabilities } from "./contract.ts";
import { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
import { loadSetup } from "./loader.ts";
import type { Setup } from "./loader.ts";
import { ConnectorError, findConnectors, loadConnector } from "./registry.ts";
import { renderTarget } from "./render.ts";
import { validateSetup } from "./validate.ts";

/** What the commands reach outside the setup. Tests pass their own. */
export interface CliContext {
  cwd: () => string;
  loadConnector: typeof loadConnector;
  findConnectors: typeof findConnectors;
}

const dirArg = {
  type: "string",
  description: "The setup's directory",
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

const printDiagnostics = (diagnostics: Diagnostics, cwd: string): void => {
  const count = diagnostics.size;
  fail([
    ...diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, cwd)),
    `${count} ${count === 1 ? "error" : "errors"}.`,
  ]);
};

/** The `--target` given, or the setup's only target. */
const pickTarget = (setup: Setup, given: string | undefined): string | undefined => {
  if (given !== undefined) return given;
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
    ...context,
  };

  const validate = defineCommand({
    meta: {
      name: "validate",
      description:
        "Check the schemas, every reference (traits, params, vars, workflows, slots, templates) and the workflow graph",
    },
    args: { dir: dirArg, target: { ...targetArg, description: "Check only this target" } },
    run: ({ args }) => {
      const cwd = ctx.cwd();
      const diagnostics = new Diagnostics();
      const setup = loadSetup(resolve(cwd, args.dir), diagnostics);
      validateSetup(setup, diagnostics, args.target === undefined ? {} : { target: args.target });
      if (diagnostics.size > 0) return printDiagnostics(diagnostics, cwd);
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
      const setup = loadSetup(resolve(cwd, args.dir), diagnostics);
      const slug = pickTarget(setup, args.target);
      if (slug === undefined) return;
      validateSetup(setup, diagnostics, { target: slug });
      if (diagnostics.size > 0) return printDiagnostics(diagnostics, cwd);
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
      if (!rendered || diagnostics.size > 0) return printDiagnostics(diagnostics, cwd);
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
      init: notYet(
        "init",
        "Write .10xagents/10xagents.config.ts extending a source, plus a starter target",
      ),
      install: notYet("install", "Fetch the remote sources and write 10xagents.lock"),
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
