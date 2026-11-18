import { mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { defineCommand, runCommand } from "citty";
import type { CommandDef } from "citty";

import pkg from "../package.json" with { type: "json" };
import { claudeCodeCollector } from "./bench/claude-code.ts";
import { BenchError, formatReport, runBench } from "./bench/run.ts";
import { appendSyncLog, setupHash, SYNC_LOG } from "./bench/sync-log.ts";
import { buildFiles, writeFiles } from "./build.ts";
import type { Config } from "./config.ts";
import type { Capabilities, Change, Collector, Connector, PullOptions } from "./contract.ts";
import { Diagnostics, formatDiagnostic } from "./diagnostics.ts";
import { defaultCacheDir, githubFetcher } from "./fetch.ts";
import { initSetup, installSetup } from "./install.ts";
import { defaultBundledDir, openSetup } from "./layers.ts";
import type { Opened, SourceOptions } from "./layers.ts";
import type { LoadedTarget, Setup } from "./loader.ts";
import { ConnectorError, findConnectors, loadConnector } from "./registry.ts";
import { renderTarget } from "./render.ts";
import type { RenderedSetup } from "./render.ts";
import { formatSource } from "./source.ts";
import { validateSetup } from "./validate.ts";

/** What the commands reach outside the setup. Tests pass their own. */
export interface CliContext {
  cwd: () => string;
  loadConnector: typeof loadConnector;
  findConnectors: typeof findConnectors;
  /** How sources are fetched and cached, and where the bundled setups are. */
  sources: () => SourceOptions;
  /** Asks the person running the CLI, or is missing when there's no terminal to ask in. */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** The collectors `bench` runs beside the connector. */
  collectors: () => Collector[];
  /** Now, in milliseconds since the epoch. */
  now: () => number;
}

/**
 * Asks on the terminal, when `input` is one. The question goes to standard error, so standard
 * output carries only the command's output, like the report of `bench --format json`.
 */
export const terminalAsk = (
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): ((question: string) => Promise<string>) | undefined => {
  if (!input.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input, output: process.stderr });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
};

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

/**
 * The targets `plan` and `sync` go through: the `--target` given, else the setup's own targets
 * (those in its own `targets/` folder, not an extended setup's), in slug order, else the config's
 * `target` or the only target. `undefined` after an error.
 */
const liveTargets = (opened: Opened, given: string | undefined): string[] | undefined => {
  if (given !== undefined) return [given];
  const { setup } = opened;
  const own = [...setup.targets]
    .filter(([, target]) => target.root === setup.dir)
    .map(([slug]) => slug)
    .toSorted();
  if (own.length > 0) return own;
  const slug = pickTarget(setup, opened.config, given);
  return slug === undefined ? undefined : [slug];
};

/**
 * Runs `each` on every slug in turn. With two or more, each starts with a header, after a blank
 * line. A target's errors set the exit code and leave the targets after it to run.
 */
const eachTarget = async (
  slugs: readonly string[],
  each: (slug: string) => Promise<void>,
): Promise<void> => {
  for (const [index, slug] of slugs.entries()) {
    if (slugs.length > 1) {
      if (index > 0) say("");
      say(`Target ${slug} (${index + 1} of ${slugs.length})`);
    }
    await each(slug);
  }
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

const plural = (size: number, one: string, many: string): string =>
  `${size} ${size === 1 ? one : many}`;

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
        ? `${plural(manual.length, "item needs", "items need")} setup first (see the ! lines above).`
        : "Up to date.",
    );
  } else {
    say(`${plural(toApply.length, "change", "changes")}:`);
    for (const change of toApply) {
      say(`  ${change.summary}`);
      if (diff && change.diff) say(change.diff.replace(/\n+$/, "").replace(/^/gm, "      "));
    }
  }
  return { toApply, manual: manual.length > 0 };
};

interface Planned {
  changes: Change[];
  /** Where the changes go, named for the person confirming them. */
  name: string;
  /** The options that read the same place again, with nothing left to ask. */
  again: PullOptions;
}

/** Reads the live state and plans. `undefined` after an error. */
const planLive = async (
  connector: Connector,
  rendered: RenderedSetup,
  options: PullOptions,
): Promise<Planned | undefined> => {
  try {
    const live = await connector.pull(rendered.target, { ...options, log: say });
    const place = connector.place?.(live);
    return {
      changes: await connector.plan(rendered, live),
      name: place?.name ?? options.workspace ?? rendered.target.workspace,
      again: place?.pull ?? options,
    };
  } catch (error) {
    fail([`Stopped: ${error instanceof Error ? error.message : String(error)}`]);
    return undefined;
  }
};

/** Every value of a flag given more than once, as `--name x` or `--name=x`, else `fallback`. */
const repeated = (rawArgs: readonly string[], name: string, fallback: string): string[] => {
  const values: string[] = [];
  rawArgs.forEach((arg, index) => {
    if (arg === `--${name}`) {
      const next = rawArgs[index + 1];
      if (next !== undefined && !next.startsWith("-")) values.push(next);
    } else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3));
  });
  return values.length > 0 ? values : [fallback];
};

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
    ask: terminalAsk(),
    collectors: () => [claudeCodeCollector()],
    now: () => Date.now(),
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
      const rendered = renderTarget(setup, slug, diagnostics, renderOptions(connector));
      if (rendered && diagnostics.size === 0) {
        checkForConnector(connector, rendered, target, diagnostics);
      }
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
        default: "starter",
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

  /** An opened setup, with what prints its files in messages. */
  interface Live {
    opened: Opened;
    cwd: string;
    labels: Map<string, string>;
  }

  /**
   * Opens the setup and picks its targets. `undefined` after an error: a setup that doesn't open or
   * load stops before any target, since a target that didn't load isn't among its targets.
   */
  const openLive = async (args: {
    dir: string;
    target?: string | undefined;
    workspace?: string | undefined;
  }): Promise<{ live: Live; slugs: string[] } | undefined> => {
    const cwd = ctx.cwd();
    const diagnostics = new Diagnostics();
    const labels = new Map<string, string>();
    const opened = await openSetup(args.dir, cwd, sourceOptions(labels), diagnostics);
    if (!opened) {
      printDiagnostics(diagnostics, cwd, labels);
      return undefined;
    }
    const slugs = liveTargets(opened, args.target);
    if (slugs === undefined) return undefined;
    if (args.workspace !== undefined && slugs.length > 1) {
      fail(["--workspace works on one target: add --target."]);
      return undefined;
    }
    if (diagnostics.size > 0) {
      // One target reports its own errors beside the setup's, as it always has.
      const only = slugs.length === 1 ? slugs[0] : undefined;
      if (only !== undefined) validateSetup(opened.setup, diagnostics, { target: only });
      printDiagnostics(diagnostics, cwd, labels);
      return undefined;
    }
    return { live: { opened, cwd, labels }, slugs };
  };

  /** Validates and renders one target for its connector. `undefined` after an error. */
  const prepare = async (
    { opened, cwd, labels }: Live,
    slug: string,
  ): Promise<{ connector: Connector; rendered: RenderedSetup } | undefined> => {
    const { setup } = opened;
    const diagnostics = new Diagnostics();
    validateSetup(setup, diagnostics, { target: slug });
    const target = diagnostics.size > 0 ? undefined : setup.targets.get(slug);
    if (!target) {
      printDiagnostics(diagnostics, cwd, labels);
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
      printDiagnostics(diagnostics, cwd, labels);
      return undefined;
    }
    return { connector, rendered };
  };

  const liveArgs = {
    dir: dirArg,
    target: {
      ...targetArg,
      description: "Only this target. The default is every target of the setup's own",
    },
    profile: { type: "string", description: "The platform profile to use" },
    workspace: { type: "string", description: "The workspace to use instead of the target's" },
    diff: { type: "boolean", description: "Print each text diff", default: false },
  } as const;

  /** `--profile` and `--workspace` as pull options, with the terminal to ask in. */
  const pullOptions = (args: { profile?: string | undefined; workspace?: string | undefined }) => ({
    ...(args.profile === undefined ? {} : { profile: args.profile }),
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    ...(ctx.ask ? { ask: ctx.ask } : {}),
  });

  /**
   * Appends the sync to `sync-log.jsonl`: in the setup's folder, or in `./.10xagents` for a setup
   * from GitHub or a bundled name. Local layers are named relative to the setup, so the log holds
   * no paths of this machine.
   */
  const logSync = (opened: Opened, rendered: RenderedSetup, time: string): void => {
    const root = opened.resolution.layers[0];
    const dir = opened.local && root ? root.dir : resolve(ctx.cwd(), ".10xagents");
    const sources = opened.resolution.layers.map((layer) => {
      if (layer.remote) return formatSource({ ...layer.remote.source, ref: layer.remote.sha });
      // A local layer's source is its folder; a bundled one's, its name.
      if (layer.source !== layer.dir) return layer.source;
      return relative(dir, layer.dir).split(sep).join("/") || ".";
    });
    try {
      mkdirSync(dir, { recursive: true });
      appendSyncLog(dir, {
        target: rendered.target.id,
        setupHash: setupHash(rendered),
        sources,
        time,
      });
    } catch (error) {
      fail([
        `Applied, but couldn't write ${SYNC_LOG}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  };

  const plan = defineCommand({
    meta: {
      name: "plan",
      description: "Show the connector's diff of the live state against the rendered setup",
    },
    args: liveArgs,
    run: async ({ args }) => {
      const opened = await openLive(args);
      if (!opened) return;
      await eachTarget(opened.slugs, async (slug) => {
        const prepared = await prepare(opened.live, slug);
        if (!prepared) return;
        const planned = await planLive(prepared.connector, prepared.rendered, pullOptions(args));
        if (!planned) return;
        if (printPlan(planned.changes, args.diff).manual) process.exitCode = 1;
      });
    },
  });

  const sync = defineCommand({
    meta: {
      name: "sync",
      description: "Apply the diff after you confirm, then log the setup hash to sync-log.jsonl",
    },
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
      const opened = await openLive(args);
      if (!opened) return;
      const { live } = opened;
      await eachTarget(opened.slugs, async (slug) => {
        const prepared = await prepare(live, slug);
        if (!prepared) return;
        const { connector, rendered } = prepared;
        const planned = await planLive(connector, rendered, pullOptions(args));
        if (!planned) return;
        const { toApply, manual } = printPlan(planned.changes, args.diff);
        if (manual) process.exitCode = 1;
        if (toApply.length === 0 || args["dry-run"]) return;
        if (!args.yes) {
          if (!ctx.ask) {
            return fail(["No terminal to ask in: pass --yes to apply, or --dry-run to only look."]);
          }
          const answer = await ctx.ask(
            `Apply ${plural(toApply.length, "change", "changes")} to ${planned.name}? [y/N] `,
          );
          if (!/^y(es)?$/i.test(answer.trim())) {
            say("Skipped.");
            return;
          }
        }
        const started = new Date(ctx.now()).toISOString();
        let result;
        try {
          result = await connector.apply(toApply);
        } catch (error) {
          return fail([`Stopped: ${error instanceof Error ? error.message : String(error)}`]);
        }
        const failed = result?.failed ?? [];
        // Something changed, so the setup that's live from now on goes in the log.
        if (failed.length < toApply.length) logSync(live.opened, rendered, started);
        if (failed.length > 0) {
          fail(failed.map(({ change, message }) => `Failed: ${change.summary}: ${message}`));
        }
        // A re-check of the same place, through the same account, with nothing to ask.
        const left = await planLive(connector, rendered, planned.again);
        if (!left) return;
        const leftToApply = left.changes.filter((change) => !change.manual && !change.note);
        const leftManual = left.changes.filter((change) => change.manual);
        if (leftToApply.length > 0) {
          fail([
            `${plural(leftToApply.length, "change still differs", "changes still differ")}:`,
            ...leftToApply.map((change) => `  ${change.summary}`),
          ]);
        } else if (leftManual.length > 0) {
          say(
            `Applied; ${plural(leftManual.length, "item needs", "items need")} setup first (see the ! lines above).`,
          );
          process.exitCode = 1;
        } else if (failed.length === 0) say(`Applied; ${planned.name} now matches the setup.`);
      });
    },
  });

  const bench = defineCommand({
    meta: {
      name: "bench",
      description:
        "Run every metric the connector and collectors support, over a window. The rest show as n/a",
    },
    args: {
      dir: { ...dirArg, description: "The setup's folder. Only the target's target.yaml is read" },
      target: targetArg,
      since: {
        type: "string",
        description: "Where the window starts: days back, or a local date and time",
        default: "30",
      },
      until: {
        type: "string",
        description: "Where the window ends: days back, or a local date and time. Default: now",
      },
      cutover: {
        type: "string",
        description: "Split the window at this local date and time: before, across and after",
      },
      compare: {
        type: "string",
        description: "Compare two setup hashes from sync-log.jsonl: --compare <hashA> <hashB>",
      },
      "review-step": {
        type: "string",
        description: "A status key where reviewers review delivered work (repeatable)",
        default: "quality_assurance",
      },
      "plan-step": {
        type: "string",
        description: "A status key where reviewers review plans (repeatable)",
        default: "plan_review",
      },
      profile: { type: "string", description: "The platform profile to use" },
      format: { type: "string", description: "text or json", default: "text" },
    },
    run: async ({ args, rawArgs }) => {
      if (args.format !== "text" && args.format !== "json") {
        return fail(["--format takes text or json."]);
      }
      const json = args.format === "json";
      const cwd = ctx.cwd();
      const compare =
        args.compare === undefined ? undefined : [args.compare, ...args._.slice(0, 1)];
      let report;
      try {
        report = await runBench(
          {
            dir: resolve(cwd, args.dir),
            target: args.target,
            since: args.since,
            until: args.until,
            cutover: args.cutover,
            compare,
            reviewSteps: repeated(rawArgs, "review-step", args["review-step"]),
            planSteps: repeated(rawArgs, "plan-step", args["plan-step"]),
            profile: args.profile,
            now: ctx.now(),
            ask: ctx.ask,
            // JSON goes to standard output alone, so progress goes to standard error.
            log: json ? (line) => console.error(line) : say,
          },
          {
            loadConnector: (id) => ctx.loadConnector(id, { cwd }),
            collectors: ctx.collectors(),
          },
        );
      } catch (error) {
        if (error instanceof BenchError || error instanceof ConnectorError) {
          return fail([error.message]);
        }
        return fail([`Stopped: ${error instanceof Error ? error.message : String(error)}`]);
      }
      if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else for (const line of formatReport(report)) say(line);
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
      plan,
      sync,
      bench,
      connectors,
    },
  });
};

export const main: CommandDef = createMain();

/**
 * Runs the CLI on `rawArgs`, like `["sync", "--dry-run"]`, reaching outside the setup through
 * `context`. It sets `process.exitCode` as the command line does.
 */
export const runCli = async (
  rawArgs: string[],
  context: Partial<CliContext> = {},
): Promise<void> => {
  await runCommand(createMain(context), { rawArgs });
};
