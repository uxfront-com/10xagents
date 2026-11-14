// Where a setup comes from: a local path, a bundled setup's name, or a GitHub repository.

import { existsSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

export interface LocalSource {
  kind: "local";
  /** The absolute path. */
  path: string;
}

export interface BundledSource {
  kind: "bundled";
  name: string;
}

export interface GitHubSource {
  kind: "github";
  owner: string;
  repo: string;
  /** The folder inside the repository, without leading or trailing slashes. Empty for the root. */
  subdir: string;
  /** A branch, tag or commit SHA. `undefined` means the default branch. */
  ref?: string;
}

export type Source = LocalSource | BundledSource | GitHubSource;

export class SourceError extends Error {
  override name = "SourceError";
}

const GITHUB_PREFIX = /^(?:github|gh):/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const REF = /^[A-Za-z0-9._/@+-]+$/;
/** A bundled setup's name: an id, like `ultracode`. */
export const BUNDLED_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const SHA = /^[0-9a-f]{40}$/;

/** A path: `.`, `..`, or one that starts with `./`, `../` or `/`. */
export const isLocalPath = (spec: string): boolean =>
  spec === "." ||
  spec === ".." ||
  spec.startsWith("./") ||
  spec.startsWith("../") ||
  isAbsolute(spec);

/** Parses `github:<owner>/<repo>[/<subdir>][#<ref>]`, or `gh:` for short. */
const parseGitHub = (spec: string): GitHubSource => {
  const rest = spec.replace(GITHUB_PREFIX, "");
  const hash = rest.indexOf("#");
  const path = hash === -1 ? rest : rest.slice(0, hash);
  const ref = hash === -1 ? undefined : rest.slice(hash + 1);
  const [owner = "", repo = "", ...subdir] = path.replace(/\/+$/, "").split("/");
  const bad = (why: string) =>
    new SourceError(`${spec}: ${why}. Write github:<owner>/<repo>[/<subdir>][#<ref>]`);
  if (!OWNER.test(owner)) throw bad(`${JSON.stringify(owner)} is not a GitHub owner`);
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    throw bad(`${JSON.stringify(repo)} is not a repository name`);
  }
  for (const segment of subdir) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw bad(`${JSON.stringify(segment)} is not a folder name`);
    }
  }
  if (ref !== undefined && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/"))) {
    throw bad(`${JSON.stringify(ref)} is not a branch, tag or commit`);
  }
  return {
    kind: "github",
    owner,
    repo,
    subdir: subdir.join("/"),
    ...(ref === undefined ? {} : { ref }),
  };
};

/**
 * Parses one entry of `extends`. Local paths start with `./`, `../` or `/`, and resolve from
 * `base`, the folder of the config that lists them. A bare name is a bundled setup.
 */
export const parseSource = (spec: string, base: string): Source => {
  if (GITHUB_PREFIX.test(spec)) return parseGitHub(spec);
  if (isLocalPath(spec)) return { kind: "local", path: resolve(base, spec) };
  if (BUNDLED_NAME.test(spec)) return { kind: "bundled", name: spec };
  throw new SourceError(
    `${spec}: not a source. Write a path that starts with ./ or ../, a bundled setup's name, or github:<owner>/<repo>[/<subdir>][#<ref>]`,
  );
};

/**
 * Parses `--dir` and `--from`. Unlike `extends`, a relative path needs no `./`, so
 * `--dir setups/ultracode` works. A bare name is a local folder when one exists in `cwd`, and a
 * bundled setup otherwise.
 */
export const parseDirSource = (spec: string, cwd: string): Source => {
  if (GITHUB_PREFIX.test(spec)) return parseGitHub(spec);
  const path = resolve(cwd, spec);
  if (BUNDLED_NAME.test(spec) && !existsSync(path)) return { kind: "bundled", name: spec };
  return { kind: "local", path };
};

/** The repository folder of a GitHub source as a path, like `setups/ultracode`. */
const joinSubdir = (subdir: string, relative: string): string | undefined => {
  const joined = posix.normalize(posix.join(subdir || ".", relative));
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return undefined;
  return joined === "." ? "" : joined.replace(/\/+$/, "");
};

/**
 * A local `extends` entry inside a fetched GitHub setup points at another folder of the same
 * repository, at the same commit.
 */
export const relativeGitHub = (parent: GitHubSource, sha: string, spec: string): GitHubSource => {
  if (isAbsolute(spec)) {
    throw new SourceError(`${spec}: a setup from GitHub can only extend relative paths`);
  }
  const subdir = joinSubdir(parent.subdir, spec);
  if (subdir === undefined) {
    throw new SourceError(
      `${spec}: leaves the repository ${parent.owner}/${parent.repo}, so it can't be fetched`,
    );
  }
  return { kind: "github", owner: parent.owner, repo: parent.repo, subdir, ref: sha };
};

/** The canonical text of a source, as `10xagents.lock` keys it. */
export const formatSource = (source: Source): string => {
  if (source.kind === "local") return source.path;
  if (source.kind === "bundled") return source.name;
  const subdir = source.subdir ? `/${source.subdir}` : "";
  const ref = source.ref === undefined ? "" : `#${source.ref}`;
  return `github:${source.owner}/${source.repo}${subdir}${ref}`;
};
