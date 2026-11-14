// Finds and loads connectors. The connector `<id>` is the package `@10xagents/connector-<id>`.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Connector } from "./contract.ts";

const SCOPE = "@10xagents";
const PREFIX = "connector-";

/** The package that holds connector `id`. */
export const connectorPackage = (id: string): string => `${SCOPE}/${PREFIX}${id}`;

export class ConnectorError extends Error {
  override name = "ConnectorError";
}

export interface RegistryOptions {
  /** Where the user runs the CLI. Packages installed there come first. */
  cwd?: string;
  /** Imports a module. Tests pass their own. */
  importer?: (specifier: string) => Promise<unknown>;
}

const notFound = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND");

/** Imports `specifier` from `cwd` first, then from the CLI's own location. */
const defaultImporter =
  (cwd: string) =>
  async (specifier: string): Promise<unknown> => {
    let path: string | undefined;
    try {
      path = createRequire(join(cwd, "package.json")).resolve(specifier);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    return path ? import(pathToFileURL(path).href) : import(specifier);
  };

const isConnector = (value: unknown): value is Connector => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Connector>;
  const capabilities = candidate.capabilities;
  return (
    typeof candidate.id === "string" &&
    !!capabilities &&
    typeof capabilities === "object" &&
    (["sharedContext", "workflowPerIssue", "squads", "skills"] as const).every(
      (key) => typeof capabilities[key] === "boolean",
    ) &&
    Array.isArray(capabilities.metrics) &&
    typeof candidate.pull === "function" &&
    typeof candidate.plan === "function" &&
    typeof candidate.apply === "function"
  );
};

/**
 * Loads connector `id`. The package exports it as `connector`, or as its default export.
 * Throws a `ConnectorError` when the package is missing or exports no connector.
 */
export const loadConnector = async (
  id: string,
  options: RegistryOptions = {},
): Promise<Connector> => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new ConnectorError(
      `no connector ${JSON.stringify(id)}: an id is lower case letters, digits, - and _`,
    );
  }
  const specifier = connectorPackage(id);
  const importer = options.importer ?? defaultImporter(options.cwd ?? process.cwd());
  let module: unknown;
  try {
    module = await importer(specifier);
  } catch (error) {
    if (notFound(error)) {
      throw new ConnectorError(`no connector ${id}: install ${specifier}`, { cause: error });
    }
    throw new ConnectorError(
      `connector ${id}: ${specifier} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const exports = (module ?? {}) as { connector?: unknown; default?: unknown };
  const connector = exports.connector ?? exports.default;
  if (!isConnector(connector)) {
    throw new ConnectorError(
      `connector ${id}: ${specifier} exports no connector (an object with id, capabilities, pull, plan and apply)`,
    );
  }
  if (connector.id !== id) {
    throw new ConnectorError(`connector ${id}: ${specifier} exports connector ${connector.id}`);
  }
  return connector;
};

/** Every directory from `start` up to the root. */
const ancestors = (start: string): string[] => {
  const dirs: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
};

/**
 * The ids of the connectors installed where the CLI can import them: in a `node_modules/@10xagents`
 * above `cwd` or above the CLI itself. Sorted, once each.
 */
export const findConnectors = (cwd: string = process.cwd()): string[] => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ids = new Set<string>();
  for (const dir of [...ancestors(cwd), ...ancestors(here)]) {
    const scope = join(dir, "node_modules", SCOPE);
    if (!existsSync(scope)) continue;
    for (const name of readdirSync(scope)) {
      if (name.startsWith(PREFIX) && name.length > PREFIX.length)
        ids.add(name.slice(PREFIX.length));
    }
  }
  return [...ids].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
