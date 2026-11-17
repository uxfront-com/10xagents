// Fetches GitHub sources with giget, and keeps each one in a cache, by commit SHA.

import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

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
const GH_TIMEOUT = 10_000;

const repoPath = (source: GitHubSource) =>
  `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;

/** Runs a program with an argument array, as `execFile` does. Tests pass their own. */
export type GhRunner = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; windowsHide: true; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const execFileAsync: GhRunner = promisify(execFile);

/**
 * The gh CLI's token for github.com, or `undefined` when gh isn't installed, isn't signed in or
 * fails. gh runs without `GITHUB_TOKEN` and `GH_TOKEN`, since it prints either one when it's set.
 */
export const ghAuthToken = async (run: GhRunner = execFileAsync): Promise<string | undefined> => {
  const env = { ...process.env };
  delete env["GITHUB_TOKEN"];
  delete env["GH_TOKEN"];
  try {
    const { stdout } = await run("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT,
      windowsHide: true,
      env,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

export interface GitHubFetcherOptions {
  /**
   * A token for private repositories. The default is `$GITHUB_TOKEN`, then `$GH_TOKEN`, then the
   * gh CLI's, read only when GitHub refuses a request. With this option set, gh never runs.
   */
  token?: string | undefined;
  /** Reads the gh CLI's token, or `undefined`. The default is `ghAuthToken`. Tests pass their own. */
  ghToken?: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  /** Downloads with giget. Tests pass their own. */
  downloadTemplate?: (
    input: string,
    options: { dir: string; auth?: string; registry: false; silent: true },
  ) => Promise<unknown>;
}

/** Where a request's token came from. `undefined` means no token was set at all. */
type From = "option" | "GITHUB_TOKEN" | "GH_TOKEN" | undefined;

interface Credential {
  /** The token that was set: the option's, or a variable's. */
  set: string | undefined;
  from: From;
  /** The token to send: `set`, or gh's when it has already replaced `set`. */
  token: string | undefined;
}

const NO_TOKEN = " If the repository is private, set GITHUB_TOKEN or run gh auth login.";
const GH_REFUSED =
  " The gh CLI's account can't read it either. Run gh auth status, or set GITHUB_TOKEN.";

const refused = (status: number | undefined): boolean =>
  status === 401 || status === 403 || status === 404 || status === 422;

/**
 * The hint for a failed request. `status` is GitHub's answer, or `undefined` for a download, which
 * has none. `usedGh` says that the answer was to gh's token.
 */
const hintFor = (
  { set, from }: Credential,
  status: number | undefined,
  usedGh: boolean,
): string => {
  if (status !== undefined && !refused(status)) return "";
  if (from === "option") {
    if (!set) return NO_TOKEN;
    return status === 401 || status === 403 ? " Check GITHUB_TOKEN." : "";
  }
  if (from === undefined) return usedGh ? GH_REFUSED : NO_TOKEN;
  if (usedGh) {
    return ` ${from} is invalid or expired, and the gh CLI's account can't read it either. Run gh auth status, or set a new ${from}.`;
  }
  if (status === 401)
    return ` ${from} is invalid or expired. Set a new one, or unset it and run gh auth login.`;
  if (status === 403) return ` Check ${from}.`;
  return "";
};

/** Whether a refusal with `status` lets gh's token be tried. */
const fallsBack = (cred: Credential, status: number | undefined): boolean => {
  if (cred.from === "option" || cred.token !== cred.set) return false;
  if (cred.from === undefined) return status === undefined || refused(status);
  return status === 401;
};

/**
 * Reaches GitHub's API for refs, and giget for the files. With no token set, or a variable's token
 * that GitHub rejects with a 401, a refused request is sent once more with the gh CLI's token. Once
 * GitHub accepts gh's token, every later request sends it at once.
 */
export const githubFetcher = (options: GitHubFetcherOptions = {}): Fetcher => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const readGh = options.ghToken ?? (() => ghAuthToken());
  let ghPromise: Promise<string | undefined> | undefined;
  /** gh's token, once GitHub accepted it in place of `replaces`, the token that was set. */
  let fallback: { token: string; replaces: string | undefined } | undefined;

  // Read when used, so the token in the environment at that time counts.
  const credential = (): Credential => {
    if ("token" in options) return { set: options.token, from: "option", token: options.token };
    const github = process.env["GITHUB_TOKEN"] || undefined;
    const gh = process.env["GH_TOKEN"] || undefined;
    const [set, from]: [string | undefined, From] = github
      ? [github, "GITHUB_TOKEN"]
      : gh
        ? [gh, "GH_TOKEN"]
        : [undefined, undefined];
    return { set, from, token: fallback && fallback.replaces === set ? fallback.token : set };
  };

  /** gh's token, when it may replace the one that was set: read at most once, and never the same. */
  const ghReplacing = async (cred: Credential): Promise<string | undefined> => {
    ghPromise ??= readGh().catch(() => undefined);
    const token = await ghPromise;
    return token && token !== cred.set ? token : undefined;
  };

  const commit = async (source: GitHubSource, ref: string, token: string | undefined) =>
    doFetch(
      `${API}/repos/${repoPath(source)}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: {
          Accept: "application/vnd.github.sha",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );

  return {
    async resolveRef(source) {
      const ref = source.ref ?? "HEAD";
      const cred = credential();
      const reach = async (token: string | undefined): Promise<Response> => {
        try {
          return await commit(source, ref, token);
        } catch (error) {
          throw new SourceError(
            `${formatSource(source)}: GitHub can't be reached: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      };
      let response = await reach(cred.token);
      let usedGh = cred.token !== cred.set;
      if (!response.ok && fallsBack(cred, response.status)) {
        const gh = await ghReplacing(cred);
        if (gh) {
          response = await reach(gh);
          usedGh = true;
          if (response.ok) fallback = { token: gh, replaces: cred.set };
        }
      }
      const hint = hintFor(cred, response.status, usedGh);
      if (response.status === 404 || response.status === 422) {
        throw new SourceError(
          `${formatSource(source)}: no repository ${source.owner}/${source.repo}${
            source.ref === undefined ? ", or it has no default branch" : ` with the ref ${ref}`
          }.${hint}`,
        );
      }
      if (!response.ok) {
        throw new SourceError(
          `${formatSource(source)}: GitHub answered ${response.status} ${response.statusText}.${hint}`,
        );
      }
      const sha = (await response.text()).trim();
      if (!SHA.test(sha)) {
        throw new SourceError(`${formatSource(source)}: GitHub answered with no commit SHA`);
      }
      return sha;
    },
    async download(source, sha, dir) {
      const cred = credential();
      const download = options.downloadTemplate ?? (await import("giget")).downloadTemplate;
      const input = `github:${source.owner}/${source.repo}${source.subdir ? `/${source.subdir}` : ""}#${sha}`;
      const get = (token: string | undefined) =>
        download(input, { dir, registry: false, silent: true, ...(token ? { auth: token } : {}) });
      const fail = (error: unknown, hint: string) =>
        new SourceError(
          `${formatSource(source)}: the download at ${sha} failed: ${error instanceof Error ? error.message : String(error)}.${hint}`,
          { cause: error },
        );
      let first: unknown;
      try {
        await get(cred.token);
        return;
      } catch (error) {
        first = error;
      }
      const usedGh = cred.token !== cred.set;
      // giget's message is no contract, so a variable's token is checked with one API request.
      const status =
        cred.from === "GITHUB_TOKEN" || cred.from === "GH_TOKEN"
          ? usedGh
            ? undefined
            : await commit(source, sha, cred.token).then(
                (response) => response.status,
                () => undefined,
              )
          : undefined;
      const gh = fallsBack(cred, status) ? await ghReplacing(cred) : undefined;
      if (!gh) throw fail(first, hintFor(cred, status, usedGh));
      // giget may have written part of the files, and `dir` must not exist yet.
      rmSync(dir, { recursive: true, force: true });
      try {
        await get(gh);
      } catch (error) {
        throw fail(error, hintFor(cred, undefined, true));
      }
      fallback = { token: gh, replaces: cred.set };
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
