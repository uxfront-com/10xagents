// `sync-log.jsonl`: one line per sync that applied changes, so `bench --compare` can tell which
// setup was live when a run started.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildFiles } from "../build.ts";
import { hashDir } from "../fetch.ts";
import type { RenderedSetup } from "../render.ts";

export const SYNC_LOG = "sync-log.jsonl";

export interface SyncLogEntry {
  /** The target's slug. */
  target: string;
  /** The hash of what the sync rendered, from `setupHash`. */
  setupHash: string;
  /** The setup's layers, the one that wins first: a GitHub source at its commit, a bundled name, or a local folder relative to the setup. */
  sources: string[];
  /** When the sync started applying its changes, as an ISO date and time. */
  time: string;
}

/**
 * The hash of everything a sync writes for a target: the files `build` writes and every skill's
 * files, as SHA-256 in hex. The same rendered setup always has the same hash, whatever folder or
 * machine it came from.
 */
export const setupHash = (rendered: RenderedSetup): string => {
  const hash = createHash("sha256");
  const entries = [...buildFiles(rendered)].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, content] of entries) {
    hash.update(`${path}\0${Buffer.byteLength(content)}\0`);
    hash.update(content);
  }
  for (const skill of rendered.skills) {
    const digest = hashDir(skill.dir);
    hash.update(`skills/${skill.name}\0${digest.length}\0${digest}`);
  }
  return hash.digest("hex");
};

/** Appends `entry` to `<dir>/sync-log.jsonl`, as one line of JSON. */
export const appendSyncLog = (dir: string, entry: SyncLogEntry): void => {
  appendFileSync(join(dir, SYNC_LOG), `${JSON.stringify(entry)}\n`);
};

export class SyncLogError extends Error {
  override name = "SyncLogError";
}

const isEntry = (value: unknown): value is SyncLogEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SyncLogEntry>;
  return (
    typeof entry.target === "string" &&
    typeof entry.setupHash === "string" &&
    typeof entry.time === "string" &&
    Number.isFinite(Date.parse(entry.time))
  );
};

/**
 * The entries of `<dir>/sync-log.jsonl`, oldest first. An empty list when there's no log. Throws a
 * `SyncLogError` naming the line that isn't an entry.
 */
export const readSyncLog = (dir: string): SyncLogEntry[] => {
  const file = join(dir, SYNC_LOG);
  if (!existsSync(file)) return [];
  const entries: SyncLogEntry[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      if (!isEntry(parsed)) {
        throw new SyncLogError(
          `${file}:${index + 1}: not a sync-log entry (target, setupHash and time)`,
        );
      }
      entries.push(parsed);
    });
  return entries.toSorted((a, b) => Date.parse(a.time) - Date.parse(b.time));
};

/**
 * The hash `given` stands for among `hashes`: the hash itself, or a prefix only one of them starts
 * with. Throws a `SyncLogError` when none or several match.
 */
export const matchHash = (given: string, hashes: readonly string[]): string => {
  const found = given ? [...new Set(hashes.filter((hash) => hash.startsWith(given)))] : [];
  if (found.length === 1 && found[0] !== undefined) return found[0];
  if (found.length > 1) {
    throw new SyncLogError(
      `${given} matches ${found.length} setup hashes in ${SYNC_LOG}: give more of it`,
    );
  }
  throw new SyncLogError(`no setup hash in ${SYNC_LOG} starts with ${JSON.stringify(given)}`);
};

/** The setup hash live at `time`: the last entry's at or before it, or `undefined` before the first. */
export const hashAt = (entries: readonly SyncLogEntry[], time: number): string | undefined => {
  let live: string | undefined;
  for (const entry of entries) {
    if (Date.parse(entry.time) > time) break;
    live = entry.setupHash;
  }
  return live;
};
