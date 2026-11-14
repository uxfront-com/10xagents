// A fake GitHub for the source tests: repositories in memory, and a CLI that fetches from them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runCommand } from "citty";
import { afterEach, beforeEach, vi } from "vitest";

import type { Connector } from "../src/contract.ts";
import type { Fetcher } from "../src/fetch.ts";
import type { SourceOptions } from "../src/layers.ts";
import { createMain } from "../src/main.ts";
import { formatSource, SourceError } from "../src/source.ts";
import type { GitHubSource } from "../src/source.ts";
import { tempDir } from "./helpers.ts";
import type { Files } from "./helpers.ts";

/** A commit: its files, by path from the repository's root. */
export type Commit = Files;

export interface FakeRepo {
  /** Each branch or tag, with its commit's SHA. */
  refs: Record<string, string>;
  /** Each commit's files, by SHA. */
  commits: Record<string, Commit>;
}

/** A 40-character SHA made from one character, like `sha("a")`. */
export const sha = (char: string): string => char.repeat(40);

export interface FakeGitHub extends Fetcher {
  repos: Record<string, FakeRepo>;
  resolved: string[];
  downloads: string[];
}

/** A fetcher that reads `repos`, keyed `<owner>/<repo>`, and records each call. */
export const fakeGitHub = (repos: Record<string, FakeRepo>): FakeGitHub => {
  const github: FakeGitHub = {
    repos,
    resolved: [],
    downloads: [],
    resolveRef(source: GitHubSource) {
      const repo = github.repos[`${source.owner}/${source.repo}`];
      const ref = source.ref ?? "main";
      github.resolved.push(`${source.owner}/${source.repo}#${ref}`);
      const commit = repo?.refs[ref];
      return commit
        ? Promise.resolve(commit)
        : Promise.reject(new SourceError(`${formatSource(source)}: no ref ${ref}`));
    },
    download(source: GitHubSource, commit: string, dir: string) {
      github.downloads.push(`${source.owner}/${source.repo}/${source.subdir}@${commit}`);
      const files = github.repos[`${source.owner}/${source.repo}`]?.commits[commit];
      if (!files) return Promise.reject(new SourceError(`no commit ${commit}`));
      const prefix = source.subdir ? `${source.subdir}/` : "";
      mkdirSync(dir, { recursive: true });
      for (const [path, text] of Object.entries(files)) {
        if (text === null || !path.startsWith(prefix)) continue;
        const file = join(dir, path.slice(prefix.length));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      return Promise.resolve();
    },
  };
  return github;
};

/** Prefixes every path of `files` with `folder/`. */
export const under = (folder: string, files: Files): Files =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, text]));

export const fakeConnector = (id = "fake"): Connector => ({
  id,
  capabilities: {
    sharedContext: false,
    workflowPerIssue: false,
    squads: true,
    skills: false,
    metrics: [],
  },
  pull: () => Promise.resolve({}),
  plan: () => Promise.resolve([]),
  apply: () => Promise.resolve(),
});

export const output = { out: [] as string[], err: [] as string[] };

beforeEach(() => {
  output.out = [];
  output.err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.out.push(String(chunk).replace(/\n$/, ""));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    output.err.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Source options with `github`, a fresh cache, and `bundled` as the bundled setups' folder. */
export const sourceOptions = (github: Fetcher, bundled = tempDir()): SourceOptions => ({
  fetcher: github,
  cacheDir: tempDir(),
  bundledDir: bundled,
});

/** Runs the CLI in `cwd` with `options`, and returns its exit code. */
export const cli = async (
  cwd: string,
  rawArgs: string[],
  options: SourceOptions,
): Promise<number> => {
  const command = createMain({
    cwd: () => cwd,
    loadConnector: (id) => Promise.resolve(fakeConnector(id)),
    findConnectors: () => ["fake"],
    sources: () => options,
  });
  await runCommand(command, { rawArgs });
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return Number(code);
};
