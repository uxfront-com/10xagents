// The bundled starter setup: it validates and builds as shipped, and `init` extends it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCK_FILE } from "../src/config.ts";
import { tempDir } from "./helpers.ts";
import { cli, fakeGitHub, output, sourceOptions } from "./sources-helpers.ts";

/** The repository's `setups/`, which the build bundles into the package. */
const SETUPS = join(import.meta.dirname, "..", "..", "..", "setups");
const AGENTS = ["builder", "lead", "reviewer"];

const options = () => sourceOptions(fakeGitHub({}), SETUPS);

describe("the bundled setups", () => {
  it("are only the starter, so nothing else ships in the package", () => {
    const names = readdirSync(SETUPS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(names).toEqual(["starter"]);
  });
});

describe("the bundled starter setup", () => {
  it("validates, and builds its example target with every reference resolved", async () => {
    const cwd = tempDir();
    expect(await cli(cwd, ["validate", "--dir", "starter"], options())).toBe(0);
    expect(output.out.at(-1)).toBe("Valid: 3 agents, 1 workflows, 1 target.");

    const out = join(cwd, "out");
    const args = ["build", "--dir", "starter", "--target", "example", "--out", out];
    expect(await cli(cwd, args, options())).toBe(0);
    expect(readdirSync(join(out, "agents")).toSorted()).toEqual(AGENTS.map((id) => `${id}.md`));
    const files = [
      ...AGENTS.map((id) => join("agents", `${id}.md`)),
      "squad.md",
      join("workflows", "request.json"),
    ];
    for (const file of files) {
      expect(readFileSync(join(out, file), "utf8"), file).not.toContain("{{");
    }
  });

  it("is what init extends by default, and its starter target validates and builds", async () => {
    const cwd = tempDir();
    expect(await cli(cwd, ["init", "--target", "main"], options())).toBe(0);
    const config = readFileSync(join(cwd, ".10xagents", "10xagents.config.ts"), "utf8");
    expect(config).toContain('extends: ["starter"]');
    expect(config).not.toMatch(/^import/m);
    const target = readFileSync(join(cwd, ".10xagents", "targets", "main", "target.yaml"), "utf8");
    expect(target).toContain("connector: multica");
    expect(target).toContain("owner: Owner");
    expect(target).toContain("leader: lead");
    expect(target).toContain("workflows:\n  - request\n");
    expect(readFileSync(join(cwd, ".10xagents", LOCK_FILE), "utf8")).toContain('"sources": {}');

    expect(await cli(cwd, ["validate"], options())).toBe(0);
    expect(await cli(cwd, ["build", "--target", "main", "--out", "out"], options())).toBe(0);
    expect(readdirSync(join(cwd, "out", "agents"))).toHaveLength(3);
  });
});
