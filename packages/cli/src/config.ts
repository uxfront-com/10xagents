// A setup's `10xagents.config.ts`, and its `10xagents.lock`.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as v from "valibot";

import type { Diagnostics } from "./diagnostics.ts";
import { check } from "./schema.ts";
import { SHA } from "./source.ts";

const Id = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lower case letters, digits, - and _"),
);
const SourceText = v.pipe(v.string(), v.minLength(1, "must not be empty"));

export const ConfigSchema = v.strictObject({
  /** The setups this one builds on. A later entry wins over an earlier one. */
  extends: v.optional(
    v.union([
      v.pipe(
        SourceText,
        v.transform((one) => [one]),
      ),
      v.array(SourceText),
    ]),
    [],
  ),
  /** The target `--target` picks when it's left out. */
  target: v.optional(Id),
  /** Options for each connector, by connector id. The connector reads its own. */
  connectors: v.optional(v.record(Id, v.unknown()), {}),
});
export type Config = v.InferOutput<typeof ConfigSchema>;
export type ConfigInput = v.InferInput<typeof ConfigSchema>;

/** Types a config, for setups that install `10xagents`. A config needs no import. */
export const defineConfig = (config: ConfigInput): ConfigInput => config;

export const CONFIG_FILES = [
  "10xagents.config.ts",
  "10xagents.config.mts",
  "10xagents.config.js",
  "10xagents.config.mjs",
] as const;
export const LOCK_FILE = "10xagents.lock";

export interface LoadedConfig {
  /** The config file, when the setup has one. */
  file?: string;
  config: Config;
}

/** The setup's config file, or `undefined` when it has none. */
export const findConfig = (dir: string): string | undefined =>
  CONFIG_FILES.map((name) => join(dir, name)).find((file) => existsSync(file));

/**
 * Loads `dir`'s config with jiti, so a `.ts` config needs nothing installed. A setup with no config
 * extends nothing. Errors go to `diagnostics`.
 */
export const loadConfig = async (dir: string, diagnostics: Diagnostics): Promise<LoadedConfig> => {
  const file = findConfig(dir);
  const empty: Config = { extends: [], connectors: {} };
  if (!file) return { config: empty };
  let data: unknown;
  try {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(pathToFileURL(file).href, {
      moduleCache: false,
      fsCache: false,
      interopDefault: true,
    });
    data = await jiti.import(file, { default: true });
  } catch (error) {
    diagnostics.add(
      file,
      "(config)",
      `can't be loaded: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
    );
    return { file, config: empty };
  }
  const parsed = check(ConfigSchema, data ?? {});
  for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
  return { file, config: parsed.output ?? empty };
};

/** The text `init` writes: a plain object, so loading it needs no package. */
export const configText = (config: { extends: readonly string[]; target?: string }): string =>
  [
    "// The setups this one builds on, the last one first. `10xagents install` pins each",
    "// GitHub source to a commit in 10xagents.lock.",
    "export default {",
    `  extends: [${config.extends.map((source) => JSON.stringify(source)).join(", ")}],`,
    ...(config.target === undefined
      ? []
      : [
          `  // The target \`--target\` picks when it's left out.`,
          `  target: ${JSON.stringify(config.target)},`,
        ]),
    "};",
    "",
  ].join("\n");

const LockEntrySchema = v.strictObject({
  sha: v.pipe(v.string(), v.regex(SHA, "must be a 40-character commit SHA")),
  hash: v.pipe(v.string(), v.regex(/^sha256-[A-Za-z0-9+/]{43}=$/, "must be sha256-<base64>")),
});
const LockSchema = v.strictObject({
  lockfileVersion: v.literal(1, "must be 1"),
  sources: v.record(v.string(), LockEntrySchema),
});

export type LockEntry = v.InferOutput<typeof LockEntrySchema>;
/** Each remote source, as `formatSource` writes it, with its commit and the hash of its files. */
export type Lock = Map<string, LockEntry>;

/** Reads `dir`'s lock. `undefined` when there is none, or when it's broken (reported). */
export const readLock = (dir: string, diagnostics: Diagnostics): Lock | undefined => {
  const file = join(dir, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    diagnostics.add(
      file,
      "(json)",
      `${error instanceof Error ? error.message : String(error)}. Run 10xagents install to write it again`,
    );
    return undefined;
  }
  const parsed = check(LockSchema, data);
  for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
  return parsed.output ? new Map(Object.entries(parsed.output.sources)) : undefined;
};

/** The lock's text: sorted keys, so the same sources give the same bytes. */
export const lockText = (lock: Lock): string => {
  const sources = Object.fromEntries(
    [...lock.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([source, entry]) => [source, { sha: entry.sha, hash: entry.hash }]),
  );
  return `${JSON.stringify({ lockfileVersion: 1, sources }, null, 2)}\n`;
};

/** Writes `text` to `file` through a temporary file, so a reader never sees half of it. */
export const writeAtomic = (file: string, text: string): void => {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
};
