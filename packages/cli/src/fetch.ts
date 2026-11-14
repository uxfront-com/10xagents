// Fetches GitHub sources with giget, and keeps each one in a cache, by commit SHA.

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import type { GitHubSource } from "./source.ts";
import { formatSource, SHA, SourceError } from "./source.ts";

/** What reaches GitHub. Tests pass their own. */
export interface Fetcher {
  /** The commit SHA that the source's ref points to now. */
  resolveRef(source: GitHubSource): Promise<string>;
  /** Writes the source's folder at commit `sha` into `dir`, which doesn't exist yet. */
  download(source: GitHubSource, sha: string, dir: string): Promise<void>;
}

const API = "https://api.github.com";
const TIMEOUT = 30_000;

const repoPath = (source: GitHubSource) =>
  `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;

export interface GitHubFetcherOptions {
  /** A token for private repositories. The default is `$GITHUB_TOKEN`. */
  token?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Downloads with giget. Tests pass their own. */
  downloadTemplate?: (
    input: string,
    options: { dir: string; auth?: string; registry: false; silent: true },
  ) => Promise<unknown>;
}

const hint = (token: string | undefined): string =>
  token ? "" : " If the repository is private, set GITHUB_TOKEN.";

/** Reaches GitHub's API for refs, and giget for the files. */
export const githubFetcher = (options: GitHubFetcherOptions = {}): Fetcher => {
  // Read when used, so the token in the environment at that time counts.
  const tokenNow = (): string | undefined =>
    "token" in options ? options.token : process.env["GITHUB_TOKEN"] || undefined;
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async resolveRef(source) {
      const token = tokenNow();
      const privateHint = hint(token);
      const ref = source.ref ?? "HEAD";
      const url = `${API}/repos/${repoPath(source)}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`;
      let response: Response;
      try {
        response = await doFetch(url, {
          headers: {
            Accept: "application/vnd.github.sha",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (error) {
        throw new SourceError(
          `${formatSource(source)}: GitHub can't be reached: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (response.status === 404 || response.status === 422) {
        throw new SourceError(
          `${formatSource(source)}: no repository ${source.owner}/${source.repo}${
            source.ref === undefined ? ", or it has no default branch" : ` with the ref ${ref}`
          }.${privateHint}`,
        );
      }
      if (!response.ok) {
        throw new SourceError(
          `${formatSource(source)}: GitHub answered ${response.status} ${response.statusText}.${
            response.status === 401 || response.status === 403
              ? privateHint || " Check GITHUB_TOKEN."
              : ""
          }`,
        );
      }
      const sha = (await response.text()).trim();
      if (!SHA.test(sha)) {
        throw new SourceError(`${formatSource(source)}: GitHub answered with no commit SHA`);
      }
      return sha;
    },
    async download(source, sha, dir) {
      const token = tokenNow();
      const privateHint = hint(token);
      const auth = token ? { auth: token } : {};
      const download = options.downloadTemplate ?? (await import("giget")).downloadTemplate;
      const input = `github:${source.owner}/${source.repo}${source.subdir ? `/${source.subdir}` : ""}#${sha}`;
      try {
        await download(input, { dir, registry: false, silent: true, ...auth });
      } catch (error) {
        throw new SourceError(
          `${formatSource(source)}: the download at ${sha} failed: ${error instanceof Error ? error.message : String(error)}.${privateHint}`,
          { cause: error },
        );
      }
    },
  };
};

/** The cache's folder: `$XDG_CACHE_HOME/10xagents`, or `~/.cache/10xagents`. */
export const defaultCacheDir = (): string =>
  join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "10xagents");

/** Every file under `dir`, as sorted `/`-separated paths. Throws on a symlink. */
const listFiles = (dir: string, label: string): string[] => {
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new SourceError(
          `${label}: ${relative(dir, path).split(sep).join("/")} is a symlink, which a fetched setup can't hold`,
        );
      }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * The hash of a folder's files: their paths and bytes, as `sha256-<base64>`. Throws on a symlink,
 * so a fetched setup can't point at a file outside itself.
 */
export const hashDir = (dir: string, label = dir): string => {
  const hash = createHash("sha256");
  for (const file of listFiles(dir, label)) {
    const bytes = readFileSync(join(dir, ...file.split("/")));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return `sha256-${hash.digest("base64")}`;
};

export interface Fetched {
  dir: string;
  hash: string;
}

/** The cache entry of a source at a commit. Different folders of one commit get their own. */
const entryDir = (cacheDir: string, source: GitHubSource, sha: string): string => {
  const folder = createHash("sha256").update(source.subdir).digest("hex").slice(0, 12);
  return join(cacheDir, "github", source.owner, source.repo, `${sha}-${folder}`);
};

const download = async (
  fetcher: Fetcher,
  source: GitHubSource,
  sha: string,
  entry: string,
  label: string,
): Promise<void> => {
  mkdirSync(join(entry, ".."), { recursive: true });
  // Download beside the entry, then rename, so a crash or a parallel run never leaves half a setup.
  const temp = `${entry}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fetcher.download(source, sha, temp);
    if (!existsSync(temp) || readdirSync(temp).length === 0) {
      throw new SourceError(
        source.subdir
          ? `${label}: the repository has no folder ${source.subdir} at ${sha}`
          : `${label}: the repository is empty at ${sha}`,
      );
    }
    hashDir(temp, label);
    rmSync(entry, { recursive: true, force: true });
    try {
      renameSync(temp, entry);
    } catch (error) {
      // A parallel run renamed its copy first. Same commit, same files.
      if (!existsSync(entry)) throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

/**
 * The folder of `source` at commit `sha`, from the cache, or downloaded into it. With `expected`,
 * a cached copy whose hash differs is downloaded again, and a fresh copy that still differs fails.
 */
export const fetchSource = async (
  fetcher: Fetcher,
  cacheDir: string,
  source: GitHubSource,
  sha: string,
  expected?: string,
): Promise<Fetched> => {
  const label = formatSource({ ...source, ref: sha });
  const entry = entryDir(cacheDir, source, sha);
  if (existsSync(entry)) {
    const hash = hashDir(entry, label);
    if (expected === undefined || hash === expected) return { dir: entry, hash };
  }
  await download(fetcher, source, sha, entry, label);
  const hash = hashDir(entry, label);
  if (expected !== undefined && hash !== expected) {
    throw new SourceError(
      `${label}: the files' hash is ${hash}, but 10xagents.lock has ${expected}. Run 10xagents install --update if the source should change`,
    );
  }
  return { dir: entry, hash };
};
