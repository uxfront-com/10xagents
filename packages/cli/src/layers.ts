// Opens a setup from any source, follows its `extends`, and merges the layers into one setup.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config, Lock } from "./config.ts";
import { loadConfig, readLock } from "./config.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { Fetcher } from "./fetch.ts";
import { fetchSource } from "./fetch.ts";
import type { Setup } from "./loader.ts";
import { loadLayer, mergeLayers } from "./loader.ts";
import type { GitHubSource, Source } from "./source.ts";
import {
  formatSource,
  isLocalPath,
  parseDirSource,
  parseSource,
  relativeGitHub,
  SHA,
  SourceError,
} from "./source.ts";

/**
 * How remote sources get their commit:
 * - `frozen`: from `10xagents.lock`, and a source missing from it fails. `build`, `validate`,
 *   `plan` and `sync` on a local setup.
 * - `prefer-lock`: from the lock when it has the source, and from GitHub otherwise. `install`, and
 *   a setup opened from GitHub or a bundled name, whose lock is its own.
 * - `update`: from GitHub, always. `install --update`.
 */
export type LockMode = "frozen" | "prefer-lock" | "update";

export interface SourceOptions {
  fetcher: Fetcher;
  /** Where fetched sources are kept, by commit. */
  cacheDir: string;
  /** The folder that holds the bundled setups. */
  bundledDir: string;
  /** Called with each remote source and the commit it resolved to now, rather than from a lock. */
  onResolve?: (source: string, sha: string) => void;
  /** Filled with each fetched folder and its source at its commit, for messages. */
  labels?: Map<string, string>;
}

/** The bundled setups' folder: `setups/` beside the package's `src/` or `dist/`. */
export const defaultBundledDir = (): string => fileURLToPath(new URL("../setups", import.meta.url));

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

const bundledNames = (bundledDir: string): string[] =>
  isDir(bundledDir)
    ? readdirSync(bundledDir)
        .filter((name) => !name.startsWith(".") && isDir(join(bundledDir, name)))
        .toSorted()
    : [];

/** One layer, opened: where its files are and what its config says. */
export interface OpenedLayer {
  /** The source, as written in the lock or a message. */
  source: string;
  dir: string;
  config: Config;
  /** The config file, or a label for messages when the layer has none. */
  configFile: string;
  /** For a GitHub layer: its source and commit, so its relative `extends` stay in the repository. */
  remote?: { source: GitHubSource; sha: string };
}

export interface Resolution {
  /** Every layer, the one that wins first. The first is the setup itself. */
  layers: OpenedLayer[];
  /** Every remote source the layers reach, with its commit and hash: the lock to write. */
  lock: Lock;
}

/** The most layers one setup can have, so a runaway chain of sources stops. */
const MAX_LAYERS = 64;

/** A layer's identity, so a cycle or a layer reached twice is found. */
const identity = (layer: OpenedLayer): string =>
  layer.remote
    ? formatSource({ ...layer.remote.source, ref: layer.remote.sha })
    : realDir(layer.dir);

const realDir = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * Follows `root`'s `extends`, depth first. A layer comes before the layers it extends, and of its
 * `extends`, the last listed comes first. A layer reached twice keeps its last place, so it stays
 * under every layer that extends it.
 */
export const resolveLayers = async (
  root: OpenedLayer,
  mode: LockMode,
  lock: Lock | undefined,
  options: SourceOptions,
  diagnostics: Diagnostics,
): Promise<Resolution> => {
  const resolved: Lock = new Map();
  const remote = new Map<string, Promise<{ sha: string; dir: string; hash: string }>>();
  let count = 1;

  const fetchRemote = (source: GitHubSource) => {
    const key = formatSource(source);
    let pending = remote.get(key);
    if (!pending) {
      pending = (async () => {
        const entry = lock?.get(key);
        if (mode === "frozen" && !entry) {
          throw new SourceError(
            lock
              ? `${key} is not in 10xagents.lock: run 10xagents install`
              : `${key} needs a 10xagents.lock: run 10xagents install`,
          );
        }
        // A source pinned to a commit keeps it, whatever the lock says.
        let sha: string;
        if (source.ref !== undefined && SHA.test(source.ref)) sha = source.ref;
        else if (entry && mode !== "update") sha = entry.sha;
        else {
          sha = await options.fetcher.resolveRef(source);
          options.onResolve?.(key, sha);
        }
        const fetched = await fetchSource(
          options.fetcher,
          options.cacheDir,
          source,
          sha,
          entry?.sha === sha ? entry.hash : undefined,
        );
        resolved.set(key, { sha, hash: fetched.hash });
        options.labels?.set(fetched.dir, formatSource({ ...source, ref: sha }));
        return { sha, ...fetched };
      })();
      remote.set(key, pending);
    }
    return pending;
  };

  const open = async (
    spec: string,
    parent: OpenedLayer,
    field: string,
  ): Promise<OpenedLayer | undefined> => {
    const report = (message: string) => diagnostics.add(parent.configFile, field, message);
    try {
      const source: Source =
        parent.remote && isLocalPath(spec)
          ? relativeGitHub(parent.remote.source, parent.remote.sha, spec)
          : parseSource(spec, parent.dir);
      if (source.kind === "github") {
        const fetched = await fetchRemote(source);
        const { config, file } = await loadConfig(fetched.dir, diagnostics);
        return {
          source: formatSource(source),
          dir: fetched.dir,
          config,
          configFile: file ?? join(fetched.dir, "10xagents.config.ts"),
          remote: { source, sha: fetched.sha },
        };
      }
      const dir = source.kind === "local" ? source.path : join(options.bundledDir, source.name);
      if (!isDir(dir)) {
        if (source.kind === "local") report(`${spec}: no setup folder at ${dir}`);
        else {
          const names = bundledNames(options.bundledDir);
          report(
            `${spec}: no bundled setup ${source.name}${names.length > 0 ? `. Bundled: ${names.join(", ")}` : ""}`,
          );
        }
        return undefined;
      }
      const { config, file } = await loadConfig(dir, diagnostics);
      return {
        source: source.kind === "local" ? dir : source.name,
        dir,
        config,
        configFile: file ?? join(dir, "10xagents.config.ts"),
      };
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      report(error.message);
      return undefined;
    }
  };

  const visit = async (layer: OpenedLayer, path: readonly string[]): Promise<OpenedLayer[]> => {
    const out = [layer];
    const specs = layer.config.extends;
    for (let index = specs.length - 1; index >= 0; index -= 1) {
      const field = `extends[${index}]`;
      if (count >= MAX_LAYERS) {
        diagnostics.add(layer.configFile, field, `a setup can have at most ${MAX_LAYERS} layers`);
        break;
      }
      const child = await open(specs[index] ?? "", layer, field);
      if (!child) continue;
      const id = identity(child);
      if (path.includes(id)) {
        diagnostics.add(
          layer.configFile,
          field,
          `extends ${child.source}, which extends this setup: a cycle`,
        );
        continue;
      }
      count += 1;
      out.push(...(await visit(child, [...path, id])));
    }
    return out;
  };

  const all = await visit(root, [identity(root)]);
  // A layer reached twice keeps its last place.
  const last = new Map(all.map((layer, index) => [identity(layer), index]));
  const layers = all.filter((layer, index) => last.get(identity(layer)) === index);
  return { layers, lock: resolved };
};

export interface Opened {
  setup: Setup;
  /** The setup's own config. */
  config: Config;
  resolution: Resolution;
  /** The setup's own source: a local folder, a bundled name, or a GitHub source at its commit. */
  source: string;
  /** Whether the setup's folder is local, so `install` and `init` can write to it. */
  local: boolean;
}

/** Opens the root of a setup from `--dir`: a local folder, a bundled name, or GitHub. */
export const openRoot = async (
  spec: string,
  cwd: string,
  options: SourceOptions,
  diagnostics: Diagnostics,
): Promise<{ layer: OpenedLayer; local: boolean } | undefined> => {
  const report = (message: string) => diagnostics.add("--dir", "(source)", message);
  let source: Source;
  try {
    source = parseDirSource(spec, cwd);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    report(error.message);
    return undefined;
  }
  if (source.kind === "github") {
    try {
      const sha =
        source.ref !== undefined && SHA.test(source.ref)
          ? source.ref
          : await options.fetcher.resolveRef(source);
      options.onResolve?.(formatSource(source), sha);
      const fetched = await fetchSource(options.fetcher, options.cacheDir, source, sha);
      options.labels?.set(fetched.dir, formatSource({ ...source, ref: sha }));
      const { config, file } = await loadConfig(fetched.dir, diagnostics);
      return {
        local: false,
        layer: {
          source: formatSource(source),
          dir: fetched.dir,
          config,
          configFile: file ?? join(fetched.dir, "10xagents.config.ts"),
          remote: { source, sha },
        },
      };
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      report(error.message);
      return undefined;
    }
  }
  const dir = source.kind === "local" ? source.path : join(options.bundledDir, source.name);
  if (source.kind === "bundled" && !isDir(dir)) {
    const names = bundledNames(options.bundledDir);
    report(
      `${spec}: no folder ${spec} here, and no bundled setup ${spec}${names.length > 0 ? `. Bundled: ${names.join(", ")}` : ""}`,
    );
    return undefined;
  }
  const { config, file } = isDir(dir)
    ? await loadConfig(dir, diagnostics)
    : { config: { extends: [], connectors: {} }, file: undefined };
  return {
    local: source.kind === "local",
    layer: {
      source: source.kind === "local" ? dir : source.name,
      dir,
      config,
      configFile: file ?? join(dir, "10xagents.config.ts"),
    },
  };
};

/**
 * Opens the setup at `spec` with every layer it extends, merged. `undefined` when a config, the
 * lock or a source has an error, reported in `diagnostics`. A local setup takes its remote
 * sources from its lock (`frozen`). A setup from GitHub or a bundled name uses its own lock where it
 * has one, and resolves the rest now.
 */
export const openSetup = async (
  spec: string,
  cwd: string,
  options: SourceOptions,
  diagnostics: Diagnostics,
): Promise<Opened | undefined> => {
  const root = await openRoot(spec, cwd, options, diagnostics);
  if (!root) return undefined;
  const { layer, local } = root;
  const lock = isDir(layer.dir) ? readLock(layer.dir, diagnostics) : undefined;
  const resolution = await resolveLayers(
    layer,
    local ? "frozen" : "prefer-lock",
    lock,
    options,
    diagnostics,
  );
  // A layer that can't be opened would only show up again as missing items.
  if (diagnostics.size > 0) return undefined;
  const setup = mergeLayers(
    resolution.layers.map((opened) => loadLayer(opened.dir, diagnostics)),
    diagnostics,
  );
  return {
    setup,
    config: layer.config,
    resolution,
    source: layer.remote
      ? formatSource({ ...layer.remote.source, ref: layer.remote.sha })
      : layer.source,
    local,
  };
};
