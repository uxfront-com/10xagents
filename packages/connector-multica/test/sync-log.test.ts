import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "10xagents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnector } from "../src/index.ts";
import { baseFiles, fake, tempDir, writeFiles } from "./helpers.ts";

const NOW = Date.parse("2026-11-14T10:00:00Z");

/**
 * The time the five-sync test gets. Its syncs start the fake `multica` 117 times, and each start
 * is a new Node process of 35 to 45 ms, so the test needs about 5 s on a fast machine and has
 * taken over 9 s on a busy one. That is over Vitest's default of 5 s, and the processes can't be
 * made cheaper. 30 s leaves room for a slow machine and still stops a sync that hangs.
 */
const FIVE_SYNCS_TIMEOUT = 30_000;

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Runs `10xagents sync` on the setup in `dir`, with the Multica connector on the fake binary. */
const sync = async (dir: string, env: Record<string, string>, args: string[]) => {
  await runCli(["sync", "--dir", ".", "--target", "t", "--profile", "p1", ...args], {
    cwd: () => dir,
    loadConnector: () => Promise.resolve(createConnector({ env, desktop: "/nowhere/multica" })),
    findConnectors: () => ["multica"],
    collectors: () => [],
    now: () => NOW,
  });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
};

const logOf = (dir: string): Record<string, unknown>[] => {
  const file = join(dir, "sync-log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === "object" ? { ...parsed } : {};
    });
};

describe("sync-log.jsonl", () => {
  it(
    "gets exactly one line per sync that applies changes, and none with --dry-run",
    async () => {
      const dir = writeFiles(tempDir(), baseFiles());
      const multica = fake();

      expect(await sync(dir, multica.env, ["--dry-run"])).toBe(0);
      expect(logOf(dir)).toEqual([]);

      expect(await sync(dir, multica.env, ["--yes"])).toBe(0);
      const [first] = logOf(dir);
      expect(logOf(dir)).toHaveLength(1);
      expect(first).toEqual({
        target: "t",
        setupHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        sources: ["."],
        time: new Date(NOW).toISOString(),
      });

      // Up to date: nothing applied, nothing logged.
      expect(await sync(dir, multica.env, ["--yes"])).toBe(0);
      expect(logOf(dir)).toHaveLength(1);

      // A changed setup applies again, under a new hash.
      writeFileSync(join(dir, "squad.md"), "Work together, and say when you're stuck.\n");
      expect(await sync(dir, multica.env, ["--dry-run"])).toBe(0);
      expect(logOf(dir)).toHaveLength(1);
      expect(await sync(dir, multica.env, ["--yes"])).toBe(0);
      const log = logOf(dir);
      expect(log).toHaveLength(2);
      expect(log[1]?.setupHash).not.toBe(first?.setupHash);
    },
    FIVE_SYNCS_TIMEOUT,
  );

  it("gets no line when Multica refused every change", async () => {
    const dir = writeFiles(tempDir(), baseFiles());
    const multica = fake();
    multica.set((state) => {
      state.fail = {
        "skill import": "refused",
        "agent update": "refused",
        "agent skills": "refused",
        "squad update": "refused",
        "squad member": "refused",
        "workflow update": "refused",
        "workspace update": "refused",
      };
    });
    expect(await sync(dir, multica.env, ["--yes"])).toBe(1);
    expect(logOf(dir)).toEqual([]);
  });
});
