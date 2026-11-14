// Finds the `multica` CLI and runs it, with the profile's own token and server.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Where the macOS Desktop app keeps its copy of the CLI. */
export const DESKTOP_CLI =
  "/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica";

export type Env = Readonly<Record<string, string | undefined>>;

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `multica` on `PATH`, as `which` finds it. */
const onPath = (env: Env): string | undefined =>
  (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "multica"))
    .find(executable);

/**
 * The CLI to run: `$MULTICA`, then `$MULTICA_CLI_PATH`, then `multica` on `PATH`, then the macOS
 * Desktop app's. Throws when there's none.
 */
export const findMultica = (env: Env, desktop: string = DESKTOP_CLI): string => {
  const found = env.MULTICA || env.MULTICA_CLI_PATH || onPath(env);
  if (found) return found;
  if (existsSync(desktop)) return desktop;
  throw new Error("multica CLI not found: install it, or set MULTICA to its path");
};

/**
 * The environment `multica` runs in. Every inherited `MULTICA_*` variable goes, since the CLI
 * prefers them to the profile's own token, server and workspace: an agent run's would otherwise
 * sync another account. Only the workspace this call is for comes back.
 */
export const childEnv = (env: Env, workspace?: string): Record<string, string> => {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("MULTICA_")) clean[key] = value;
  }
  if (workspace) clean.MULTICA_WORKSPACE_ID = workspace;
  return clean;
};

/** The home directory, which is also where `multica` runs, away from any project's config. */
export const homeOf = (env: Env): string => env.HOME || homedir();

export interface MulticaCli {
  bin: string;
  /** `--profile <name>`, or nothing for the default profile. */
  profileArgs: string[];
  env: Env;
}

/** The text `multica <args>` prints. Throws with its error output when it fails. */
export const run = (
  cli: MulticaCli,
  args: readonly string[],
  workspace?: string,
  input?: string,
  /** The words that name the call in an error: the first three of them. */
  label: readonly string[] = args,
): string => {
  try {
    return execFileSync(cli.bin, [...cli.profileArgs, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      cwd: homeOf(cli.env),
      env: childEnv(cli.env, workspace),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    });
  } catch (error) {
    const output: unknown =
      error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    const stderr =
      typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`multica ${label.slice(0, 3).join(" ")}: ${message}`, { cause: error });
  }
};

/** `multica <args> --output json`, parsed. */
export const runJson = (cli: MulticaCli, args: readonly string[], workspace?: string): unknown => {
  const out = run(cli, [...args, "--output", "json"], workspace, undefined, args);
  try {
    return JSON.parse(out) as unknown;
  } catch (error) {
    throw new Error(`multica ${args.slice(0, 3).join(" ")}: printed no JSON`, { cause: error });
  }
};
