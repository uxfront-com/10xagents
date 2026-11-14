import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { defineCommand } from "citty";
import type { CommandDef } from "citty";

import pkg from "../package.json" with { type: "json" };
import { buildFiles, writeFiles } from "./build.ts";
import type { Capabilities, Change, Connector, LiveState } from "./contract.ts";
import { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
import { loadSetup } from "./loader.ts";
import type { LoadedTarget, Setup } from "./loader.ts";
import { ConnectorError, findConnectors, loadConnector } from "./registry.ts";
import { renderTarget } from "./render.ts";
import type { RenderedSetup } from "./render.ts";
import { validateSetup } from "./validate.ts";

/** What the commands reach outside the setup. Tests pass their own. */
export interface CliContext {
  cwd: () => string;
  loadConnector: typeof loadConnector;
  findConnectors: typeof findConnectors;
  /** Asks the person running the CLI, or is missing when there's no terminal to ask in. */
  ask?: ((question: string) => Promise<string>) | undefined;
}

/** Asks on the terminal, when standard input is one. */
const terminalAsk = (): ((question: string) => Promise<string>) | undefined => {
  if (!process.stdin.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
};

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

const renderOptions = (connector: Connector) => ({
  sharedContext: connector.capabilities.sharedContext,
  ...(connector.columnNames ? { columnNames: connector.columnNames.bind(connector) } : {}),
});

/** Adds what the connector's platform would refuse, at the target's file unless it names one. */
const checkForConnector = (
  connector: Connector,
  rendered: RenderedSetup,
  target: LoadedTarget,
  diagnostics: Diagnostics,
): void => {
  for (const issue of connector.validate?.(rendered) ?? []) {
    diagnostics.add(issue.file ?? target.file, issue.field, issue.message);
  }
};

/** Prints the plan. Returns the changes to apply, and whether a person has to act. */
const printPlan = (changes: readonly Change[], diff: boolean) => {
  const toApply = changes.filter((change) => !change.manual && !change.note);
  const manual = changes.filter((change) => change.manual);
  for (const change of changes.filter((item) => item.manual || item.note)) {
    say(`  ${change.summary}`);
  }
  if (toApply.length === 0) {
    say(
      manual.length > 0
        ? `${manual.length} ${manual.length === 1 ? "item needs" : "items need"} setup first (see the ! lines above).`
        : "Up to date.",
    );
  } else {
    say(`${toApply.length} ${toApply.length === 1 ? "change" : "changes"}:`);
    for (const change of toApply) {
      say(`  ${change.summary}`);
      if (diff && change.diff) say(change.diff.replace(/\n+$/, "").replace(/^/gm, "      "));
    }
  }
  return { toApply, manual: manual.length > 0 };
};

export const createMain = (context: Partial<CliContext> = {}): CommandDef => {
  const ctx: CliContext = {
    cwd: () => process.cwd(),
    loadConnector,
    findConnectors,
    ask: terminalAsk(),
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
      const rendered = renderTarget(setup, slug, diagnostics, renderOptions(connector));
      if (!rendered || diagnostics.size > 0) return printDiagnostics(diagnostics, cwd);
      checkForConnector(connector, rendered, target, diagnostics);
      if (diagnostics.size > 0) return printDiagnostics(diagnostics, cwd);
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

  /** Loads, validates and renders a target for its connector. `undefined` after an error. */
  const prepare = async (
    dir: string,
    given: string | undefined,
  ): Promise<{ connector: Connector; rendered: RenderedSetup } | undefined> => {
    const cwd = ctx.cwd();
    const diagnostics = new Diagnostics();
    const setup = loadSetup(resolve(cwd, dir), diagnostics);
    const slug = pickTarget(setup, given);
    if (slug === undefined) return undefined;
    validateSetup(setup, diagnostics, { target: slug });
    const target = diagnostics.size > 0 ? undefined : setup.targets.get(slug);
    if (!target) {
      printDiagnostics(diagnostics, cwd);
      return undefined;
    }
    let connector: Connector;
    try {
      connector = await ctx.loadConnector(target.target.connector, { cwd });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      fail([error.message]);
      return undefined;
    }
    const rendered = renderTarget(setup, slug, diagnostics, renderOptions(connector));
    if (rendered && diagnostics.size === 0) {
      checkForConnector(connector, rendered, target, diagnostics);
    }
    if (!rendered || diagnostics.size > 0) {
      printDiagnostics(diagnostics, cwd);
      return undefined;
    }
    return { connector, rendered };
  };

  const liveArgs = {
    dir: dirArg,
    target: targetArg,
    profile: { type: "string", description: "The platform profile to use" },
    workspace: { type: "string", description: "The workspace to use instead of the target's" },
    diff: { type: "boolean", description: "Print each text diff", default: false },
  } as const;

  /** Reads the live state and plans. `undefined` after an error. */
  const planLive = async (
    connector: Connector,
    rendered: RenderedSetup,
    args: { profile?: string | undefined; workspace?: string | undefined },
  ): Promise<Change[] | undefined> => {
    try {
      const live: LiveState = await connector.pull(rendered.target, {
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(ctx.ask ? { ask: ctx.ask } : {}),
        log: say,
      });
      return await connector.plan(rendered, live);
    } catch (error) {
      fail([`Stopped: ${error instanceof Error ? error.message : String(error)}`]);
      return undefined;
    }
  };

  const plan = defineCommand({
    meta: {
      name: "plan",
      description: "Show the connector's diff of the live state against the rendered setup",
    },
    args: liveArgs,
    run: async ({ args }) => {
      const prepared = await prepare(args.dir, args.target);
      if (!prepared) return;
      const changes = await planLive(prepared.connector, prepared.rendered, args);
      if (!changes) return;
      const { manual } = printPlan(changes, args.diff);
      if (manual) process.exitCode = 1;
    },
  });

  const sync = defineCommand({
    meta: { name: "sync", description: "Apply the diff after you confirm" },
    args: {
      ...liveArgs,
      "dry-run": {
        type: "boolean",
        description: "Show what would change, and stop",
        default: false,
      },
      yes: { type: "boolean", description: "Apply without asking", default: false },
    },
    run: async ({ args }) => {
      const prepared = await prepare(args.dir, args.target);
      if (!prepared) return;
      const { connector, rendered } = prepared;
      const changes = await planLive(connector, rendered, args);
      if (!changes) return;
      const { toApply, manual } = printPlan(changes, args.diff);
      if (manual) process.exitCode = 1;
      if (toApply.length === 0 || args["dry-run"]) return;
      if (!args.yes) {
        if (!ctx.ask) {
          return fail(["No terminal to ask in: pass --yes to apply, or --dry-run to only look."]);
        }
        const count = `${toApply.length} ${toApply.length === 1 ? "change" : "changes"}`;
        const answer = await ctx.ask(`Apply ${count} to ${rendered.target.workspace}? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          say("Skipped.");
          return;
        }
      }
      let result;
      try {
        result = await connector.apply(toApply);
      } catch (error) {
        return fail([`Stopped: ${error instanceof Error ? error.message : String(error)}`]);
      }
      const failed = result?.failed ?? [];
      if (failed.length > 0) {
        fail(failed.map(({ change, message }) => `Failed: ${change.summary}: ${message}`));
      }
      // A re-check: what still differs after the apply is a failure.
      const left = await planLive(connector, rendered, args);
      if (!left) return;
      const leftToApply = left.filter((change) => !change.manual && !change.note);
      const leftManual = left.filter((change) => change.manual);
      if (leftToApply.length > 0) {
        fail([
          `${leftToApply.length} ${leftToApply.length === 1 ? "change still differs" : "changes still differ"}:`,
          ...leftToApply.map((change) => `  ${change.summary}`),
        ]);
      } else if (leftManual.length > 0) {
        say(
          `Applied; ${leftManual.length} ${leftManual.length === 1 ? "item needs" : "items need"} setup first (see the ! lines above).`,
        );
        process.exitCode = 1;
      } else say("Applied; the workspace now matches the setup.");
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
      plan,
      sync,
      bench: notYet("bench", "Run every metric the connector and collectors support"),
      connectors,
    },
  });
};

export const main: CommandDef = createMain();
