// `install` pins a setup's remote sources in its lock, and `init` writes a new setup.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { stringify } from "yaml";

import type { Lock } from "./config.ts";
import { configText, findConfig, LOCK_FILE, lockText, readLock, writeAtomic } from "./config.ts";
import { Diagnostics } from "./diagnostics.ts";
import type { OpenedLayer, SourceOptions } from "./layers.ts";
import { openRoot, resolveLayers } from "./layers.ts";
import { loadLayer, mergeLayers } from "./loader.ts";
import type { Setup } from "./loader.ts";
import { formatSource, isGitHubSpec, parseDirSource, SourceError } from "./source.ts";

export interface Installed {
  dir: string;
  lock: Lock;
  /** Whether the lock file's bytes changed. */
  changed: boolean;
}

/**
 * Resolves every remote source of the local setup at `spec` and writes its `10xagents.lock`. A
 * source already locked keeps its commit, unless `update`. Writes nothing on any error.
 */
export const installSetup = async (
  spec: string,
  cwd: string,
  update: boolean,
  options: SourceOptions,
  diagnostics: Diagnostics,
): Promise<Installed | undefined> => {
  const root = await openRoot(spec, cwd, options, diagnostics);
  if (!root) return undefined;
  if (!root.local) {
    diagnostics.add("--dir", spec, "is not a local folder: install writes 10xagents.lock into one");
    return undefined;
  }
  const { dir } = root.layer;
  if (!existsSync(dir) || !statSync(dir).isDirectory() || !findConfig(dir)) {
    diagnostics.add(
      dir,
      "(dir)",
      "has no 10xagents.config.ts: run 10xagents init, or pass --dir with a setup",
    );
    return undefined;
  }
  if (diagnostics.size > 0) return undefined;
  // A broken lock is written again from scratch, so its errors don't count.
  const lock = readLock(dir, new Diagnostics());
  const resolution = await resolveLayers(
    root.layer,
    update ? "update" : "prefer-lock",
    lock,
    options,
    diagnostics,
  );
  if (diagnostics.size > 0) return undefined;
  const file = join(dir, LOCK_FILE);
  const text = lockText(resolution.lock);
  const changed = !lock || lockText(lock) !== text;
  writeAtomic(file, text);
  return { dir, lock: resolution.lock, changed };
};

/** A target id from a folder name: lower case, with anything else as `-`. */
const slugOf = (name: string): string | undefined => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "");
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : undefined;
};

/**
 * The starter target: the first target of the extended setups, under a new id, without the
 * overrides and files that only its own folder has. With none, every agent and workflow.
 */
const starterTarget = (setup: Setup, slug: string): Record<string, unknown> => {
  const first = [...setup.targets.values()].toSorted((a, b) =>
    a.target.id < b.target.id ? -1 : 1,
  )[0]?.target;
  if (!first) {
    return {
      id: slug,
      connector: "multica",
      workflows: [...setup.workflows.keys()].toSorted(),
      agents: [...setup.agents.keys()].toSorted(),
    };
  }
  return {
    id: slug,
    connector: first.connector,
    ...(first.template === undefined ? {} : { template: first.template }),
    workflows: first.workflows,
    agents: first.agents,
    ...(Object.keys(first.vars).length > 0 ? { vars: first.vars } : {}),
    ...(first.squad ? { squad: { name: first.squad.name, leader: first.squad.leader } } : {}),
  };
};

export interface Initialized {
  dir: string;
  /** The source the config extends, as written in it. */
  from: string;
  target: string;
  files: string[];
  lock: Lock;
}

/**
 * Writes a new setup in the local folder `spec`, resolved from `cwd`: a config extending `from`, a
 * starter target and the lock. A bare name is a folder, never a bundled setup. The config is a plain
 * object with no import, so it loads where `10xagents` isn't installed. Writes nothing on any error.
 */
export const initSetup = async (
  spec: string,
  from: string,
  target: string | undefined,
  cwd: string,
  options: SourceOptions,
  diagnostics: Diagnostics,
): Promise<Initialized | undefined> => {
  if (isGitHubSpec(spec)) {
    diagnostics.add("--dir", spec, "is not a local folder: init writes a setup into one");
    return undefined;
  }
  // `--dir` is the folder to write into, so a bare name is a new folder, never a bundled setup.
  const root = await openRoot(resolve(cwd, spec), cwd, options, diagnostics);
  if (!root) return undefined;
  const { dir } = root.layer;
  const existing = findConfig(dir);
  if (existing) {
    diagnostics.add(existing, "(file)", "already exists: init writes a new setup only");
    return undefined;
  }
  const slug = target ?? slugOf(basename(cwd)) ?? "main";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    diagnostics.add("--target", slug, "must be lower case letters, digits, - and _");
    return undefined;
  }
  const targetFile = join(dir, "targets", slug, "target.yaml");
  if (existsSync(targetFile)) {
    diagnostics.add(targetFile, "(file)", "already exists: choose another --target");
    return undefined;
  }

  // The source as the config writes it: paths relative to the setup's folder.
  let written: string;
  try {
    const source = parseDirSource(from, cwd);
    if (source.kind === "local") {
      const path = relative(dir, source.path).split(sep).join("/");
      written = path === "" ? "." : path === ".." || path.startsWith("../") ? path : `./${path}`;
    } else written = formatSource(source);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    diagnostics.add("--from", from, error.message);
    return undefined;
  }

  const layer: OpenedLayer = {
    source: dir,
    dir,
    config: { extends: [written], target: slug, connectors: {} },
    configFile: "--from",
  };
  const resolution = await resolveLayers(layer, "prefer-lock", undefined, options, diagnostics);
  if (diagnostics.size > 0) return undefined;
  const extended = mergeLayers(
    resolution.layers.slice(1).map((opened) => loadLayer(opened.dir, diagnostics)),
    diagnostics,
  );
  if (diagnostics.size > 0) return undefined;

  mkdirSync(join(dir, "targets", slug), { recursive: true });
  const configFile = join(dir, "10xagents.config.ts");
  writeFileSync(configFile, configText({ extends: [written], target: slug }));
  writeFileSync(targetFile, stringify(starterTarget(extended, slug)));
  writeAtomic(join(dir, LOCK_FILE), lockText(resolution.lock));
  return {
    dir,
    from: written,
    target: slug,
    files: [configFile, targetFile, join(dir, LOCK_FILE)],
    lock: resolution.lock,
  };
};
