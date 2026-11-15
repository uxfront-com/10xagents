import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { configText, loadConfig, LOCK_FILE, readLock } from "../src/config.ts";
import type { Lock } from "../src/config.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { fetchSource, githubFetcher, hashDir } from "../src/fetch.ts";
import {
  formatSource,
  parseDirSource,
  parseSource,
  relativeGitHub,
  SourceError,
} from "../src/source.ts";
import { baseSetup, tempDir, writeSetup } from "./helpers.ts";
import type { Files } from "./helpers.ts";
import { cli, fakeGitHub, output, sha, sourceOptions, under } from "./sources-helpers.ts";

const BASE = "github:acme/agents/setups/base#main";

/** The base setup with a trait and a global, as `acme/agents` holds it under `setups/base`. */
const baseFiles = (): Files => ({
  ...baseSetup(),
  "agents/alpha.yaml": [
    "id: alpha",
    "name: Alpha",
    "description: An agent for tests.",
    "model: { id: test-model, thinking: low }",
    "concurrency: 1",
    "traits: [tone]",
    "sections:",
    "  role: You're the Alpha.",
    "  handback: The result.",
    "",
  ].join("\n"),
  "traits/tone.md": "---\nsection: how-you-work\n---\nBase tone.\n",
  "traits/global/01-owner.md": "{{vars.owner}} owns this.\n",
});

/** `acme/agents`, with `main` at commit a and `v2` at commit b. */
const acme = (main: Files = baseFiles(), v2: Files = main) =>
  fakeGitHub({
    "acme/agents": {
      refs: { main: sha("a"), v2: sha("b") },
      commits: { [sha("a")]: under("setups/base", main), [sha("b")]: under("setups/base", v2) },
    },
  });

/** A project folder whose `.10xagents` extends `sources`, with `files` of its own. */
const project = (sources: readonly string[], files: Files = {}): string =>
  writeSetup({
    ".10xagents/10xagents.config.ts": configText({ extends: sources }),
    ...under(".10xagents", files),
  });

const promptIn = (cwd: string, out: string, agent: string): string =>
  readFileSync(join(cwd, out, "agents", `${agent}.md`), "utf8");

/** The setup's lock, as `readLock` reads it: each source's commit and hash. */
const lockOf = (cwd: string, dir = ".10xagents"): Lock => {
  const lock = readLock(join(cwd, dir), new Diagnostics());
  if (!lock) throw new Error(`no valid lock in ${dir}`);
  return lock;
};

const tone = (text: string): string => `---\nsection: how-you-work\n---\n${text}\n`;

const notFound = (token?: string) =>
  githubFetcher({ token, fetch: () => Promise.resolve(new Response("", { status: 404 })) });

const urlOf = (url: string | URL | Request): string =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

describe("parseSource", () => {
  it("parses github:<owner>/<repo>/<subdir>#<ref>, and gh: the same", () => {
    const long = parseSource("github:o/r/sub/dir#v1.2", "/base");
    expect(long).toEqual({ kind: "github", owner: "o", repo: "r", subdir: "sub/dir", ref: "v1.2" });
    expect(parseSource("gh:o/r/sub/dir#v1.2", "/base")).toEqual(long);
    expect(formatSource(parseSource("gh:o/r/sub/dir#v1.2", "/base"))).toBe(
      "github:o/r/sub/dir#v1.2",
    );
  });

  it("leaves the subdir and the ref out when they're not given", () => {
    expect(parseSource("github:o/r", "/base")).toEqual({
      kind: "github",
      owner: "o",
      repo: "r",
      subdir: "",
    });
    expect(parseSource("gh:o/r/#feature/x", "/base")).toEqual({
      kind: "github",
      owner: "o",
      repo: "r",
      subdir: "",
      ref: "feature/x",
    });
  });

  it("resolves ./, ../ and absolute paths from the config's folder", () => {
    expect(parseSource("./a", "/x/y")).toEqual({ kind: "local", path: "/x/y/a" });
    expect(parseSource("../a", "/x/y")).toEqual({ kind: "local", path: "/x/a" });
    expect(parseSource("/abs", "/x/y")).toEqual({ kind: "local", path: "/abs" });
  });

  it("reads a bare name as a bundled setup", () => {
    expect(parseSource("ultracode", "/x")).toEqual({ kind: "bundled", name: "ultracode" });
  });

  it.each([
    ["foo/bar", "not a source"],
    ["", "not a source"],
    ["npm:pkg", "not a source"],
    ["github:", "is not a GitHub owner"],
    ["github:o", "is not a repository name"],
    ["github:-o/r", "is not a GitHub owner"],
    ["github:o/r/../x", "is not a folder name"],
    ["github:o/r//x", "is not a folder name"],
    ["github:o/r#", "is not a branch, tag or commit"],
    ["github:o/r#a..b", "is not a branch, tag or commit"],
    ["github:o/r#a b", "is not a branch, tag or commit"],
  ])("rejects %j", (spec, message) => {
    expect(() => parseSource(spec, "/x")).toThrow(SourceError);
    expect(() => parseSource(spec, "/x")).toThrow(message);
  });

  it("reads --dir paths without ./, and a bare name as a local folder first", () => {
    const cwd = writeSetup({ "ultracode/.keep": "" });
    expect(parseDirSource("setups/x", cwd)).toEqual({ kind: "local", path: join(cwd, "setups/x") });
    expect(parseDirSource("ultracode", cwd)).toEqual({
      kind: "local",
      path: join(cwd, "ultracode"),
    });
    expect(parseDirSource("other", cwd)).toEqual({ kind: "bundled", name: "other" });
    expect(parseDirSource(".10xagents", cwd).kind).toBe("local");
    expect(parseDirSource("gh:o/r", cwd).kind).toBe("github");
  });

  it("names a --dir that's neither a folder nor a bundled setup", async () => {
    const bundled = writeSetup(under("kit", baseFiles()));
    expect(
      await cli(tempDir(), ["validate", "--dir", "nope"], sourceOptions(acme(), bundled)),
    ).toBe(1);
    expect(output.err[0]).toBe(
      "--dir: (source): nope: no folder nope here, and no bundled setup nope. Bundled: kit",
    );
  });

  it("keeps a relative path inside a GitHub setup's repository, at its commit", () => {
    const parent = { kind: "github", owner: "o", repo: "r", subdir: "setups/a" } as const;
    expect(relativeGitHub(parent, sha("c"), "../b")).toEqual({
      kind: "github",
      owner: "o",
      repo: "r",
      subdir: "setups/b",
      ref: sha("c"),
    });
    expect(relativeGitHub(parent, sha("c"), "../..").subdir).toBe("");
    expect(() => relativeGitHub(parent, sha("c"), "../../..")).toThrow("leaves the repository");
    expect(() => relativeGitHub(parent, sha("c"), "/etc")).toThrow("only extend relative paths");
  });
});

describe("extends", () => {
  it("replaces an extended trait with a local one of the same id", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = project([BASE], {
      "traits/tone.md": "---\nsection: how-you-work\n---\nLocal tone.\n",
    });
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect(await cli(cwd, ["build", "--target", "t", "--out", "out"], options)).toBe(0);
    const prompt = promptIn(cwd, "out", "alpha");
    expect(prompt).toContain("Local tone.");
    expect(prompt).not.toContain("Base tone.");
    expect(prompt).toContain("Sam owns this.");
  });

  it("appends a target's override to an extended step", async () => {
    const options = sourceOptions(acme());
    const cwd = project([BASE], {
      "targets/t/target.yaml": [
        "id: t",
        "connector: fake",
        "workflows: [flow]",
        "agents: [alpha, beta]",
        "vars: { owner: Kim }",
        "overrides:",
        "  workflows.flow.steps.todo: { append: overrides/todo.md }",
        "",
      ].join("\n"),
      "targets/t/overrides/todo.md": "Then tell {{vars.owner}}.\n",
    });
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(readFileSync(join(cwd, "out/workflows/flow.json"), "utf8")).toContain(
      '"instructions": "Start the work.\\n\\nThen tell Kim."',
    );
    // The local target replaced the extended one whole.
    expect(promptIn(cwd, "out", "alpha")).toContain("Kim owns this.");
  });

  it("lets a later extends entry win over an earlier one", async () => {
    const options = sourceOptions(acme());
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": configText({ extends: ["../first", "../second"] }),
      ...under("first", { "traits/tone.md": "---\nsection: how-you-work\n---\nFirst.\n" }),
      ...under("second", {
        ...baseFiles(),
        "traits/tone.md": "---\nsection: how-you-work\n---\nSecond.\n",
      }),
    });
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    const prompt = promptIn(cwd, "out", "alpha");
    expect(prompt).toContain("Second.");
    expect(prompt).not.toContain("First.");
  });

  it("puts each layer before the layers it extends, and a shared one under both", async () => {
    // top extends [a, b]; a and b both extend shared. b wins over a, and both over shared.
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": configText({ extends: ["../a", "../b"] }),
      "a/10xagents.config.ts": configText({ extends: ["../shared"] }),
      "a/traits/tone.md": tone("From a."),
      "a/traits/global/02-a.md": "Global a.\n",
      "b/10xagents.config.ts": configText({ extends: ["../shared"] }),
      "b/traits/global/02-a.md": "Global a, from b.\n",
      ...under("shared", { ...baseFiles(), "traits/tone.md": tone("From shared.") }),
    });
    expect(await cli(cwd, ["build", "--out", "out"], sourceOptions(acme()))).toBe(0);
    const prompt = promptIn(cwd, "out", "alpha");
    expect(prompt).toContain("From a.");
    expect(prompt).toContain("Sam owns this.\n\nGlobal a, from b.");
  });

  it("changes one step of an extended workflow with a steps-only folder", async () => {
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": configText({ extends: ["../base"] }),
      ".10xagents/workflows/flow/steps/review.md": "Review it locally.\n",
      ...under("base", baseFiles()),
    });
    expect(await cli(cwd, ["build", "--out", "out"], sourceOptions(acme()))).toBe(0);
    const flow = readFileSync(join(cwd, "out/workflows/flow.json"), "utf8");
    expect(flow).toContain('"instructions": "Review it locally."');
    expect(flow).toContain('"instructions": "Start the work."');
  });

  it("fails a steps-only folder that no extended setup has a workflow for", async () => {
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": configText({ extends: ["../base"] }),
      ".10xagents/workflows/ghost/steps/x.md": "X.\n",
      ...under("base", baseFiles()),
    });
    expect(await cli(cwd, ["validate"], sourceOptions(acme()))).toBe(1);
    expect(output.err).toContain(
      ".10xagents/workflows/ghost/workflow.yaml: (file): is missing, and no extended setup has this workflow",
    );
  });

  it("extends a bundled setup by name", async () => {
    const bundled = writeSetup(under("kit", baseFiles()));
    const cwd = project(["kit"]);
    const options = sourceOptions(acme(), bundled);
    expect(await cli(cwd, ["validate"], options)).toBe(0);
    expect(output.out).toEqual(["Valid: 2 agents, 1 workflows, 1 target."]);
  });

  it("names the bundled setups when one doesn't exist", async () => {
    const bundled = writeSetup(under("kit", baseFiles()));
    const cwd = project(["nope"]);
    expect(await cli(cwd, ["validate"], sourceOptions(acme(), bundled))).toBe(1);
    expect(output.err[0]).toBe(
      ".10xagents/10xagents.config.ts: extends[0]: nope: no bundled setup nope. Bundled: kit",
    );
  });

  it("reports a missing local folder and a bad source, with their fields", async () => {
    const cwd = project(["./missing", "foo/bar"]);
    expect(await cli(cwd, ["validate"], sourceOptions(acme()))).toBe(1);
    expect(output.err).toEqual([
      expect.stringMatching(
        /^\.10xagents\/10xagents\.config\.ts: extends\[1\]: foo\/bar: not a source/,
      ),
      expect.stringMatching(
        /^\.10xagents\/10xagents\.config\.ts: extends\[0\]: \.\/missing: no setup folder at /,
      ),
      "2 errors.",
    ]);
  });

  it("stops a cycle", async () => {
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": configText({ extends: ["../a"] }),
      "a/10xagents.config.ts": configText({ extends: ["../.10xagents"] }),
    });
    expect(await cli(cwd, ["validate"], sourceOptions(acme()))).toBe(1);
    expect(output.err[0]).toMatch(
      /^a\/10xagents\.config\.ts: extends\[0\]: extends .*, which extends this setup: a cycle$/,
    );
  });

  it("fails a config that isn't a plain object, or has an unknown field", async () => {
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": "export default { extend: ['x'] };\n",
    });
    expect(await cli(cwd, ["validate"], sourceOptions(acme()))).toBe(1);
    expect(output.err[0]).toBe(".10xagents/10xagents.config.ts: extend: is not a known field");
    writeFileSync(join(cwd, ".10xagents/10xagents.config.ts"), "throw new Error('boom');\n");
    output.err = [];
    expect(await cli(cwd, ["validate"], sourceOptions(acme()))).toBe(1);
    expect(output.err[0]).toBe(".10xagents/10xagents.config.ts: (config): can't be loaded: boom");
  });

  it("builds the config's default target when --target is left out", async () => {
    const cwd = writeSetup({
      ".10xagents/10xagents.config.ts": 'export default { target: "t" };\n',
      ...under(".10xagents", {
        ...baseFiles(),
        "targets/u/target.yaml": "id: u\nconnector: fake\nagents: [alpha]\n",
      }),
    });
    expect(await cli(cwd, ["build", "--out", "out"], sourceOptions(acme()))).toBe(0);
    expect(output.out.at(-1)).toMatch(/^Built target t:/);
  });
});

describe("install and the lock", () => {
  it("writes each remote source's commit and hash to 10xagents.lock", async () => {
    const github = acme();
    const cwd = project([BASE]);
    expect(await cli(cwd, ["install"], sourceOptions(github))).toBe(0);
    const lock = lockOf(cwd);
    expect([...lock.keys()]).toEqual([BASE]);
    expect(lock.get(BASE)?.sha).toBe(sha("a"));
    expect(lock.get(BASE)?.hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    expect(readFileSync(join(cwd, ".10xagents", LOCK_FILE), "utf8")).toMatch(
      /^\{\n {2}"lockfileVersion": 1,\n {2}"sources": \{\n/,
    );
    expect(output.out).toEqual([`${BASE} → ${sha("a")}`, "Wrote 10xagents.lock: 1 remote source."]);
  });

  it("keeps the locked commit until --update moves it", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = project([BASE]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    const first = readFileSync(join(cwd, ".10xagents", LOCK_FILE), "utf8");

    github.repos["acme/agents"] = {
      refs: { main: sha("c") },
      commits: {
        ...github.repos["acme/agents"]?.commits,
        [sha("c")]: under("setups/base", { ...baseFiles(), "traits/global/01-owner.md": "New.\n" }),
      },
    };
    github.resolved.length = 0;
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect(readFileSync(join(cwd, ".10xagents", LOCK_FILE), "utf8")).toBe(first);
    expect(github.resolved).toEqual([]);
    expect(output.out.at(-1)).toBe("Kept 10xagents.lock: 1 remote source.");

    expect(await cli(cwd, ["install", "--update"], options)).toBe(0);
    expect(lockOf(cwd).get(BASE)?.sha).toBe(sha("c"));
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(promptIn(cwd, "out", "alpha")).toContain("New.");
  });

  it("builds from the locked commit, not the ref's latest", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = project([BASE]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    github.repos["acme/agents"]!.refs["main"] = sha("b");
    github.resolved.length = 0;
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(github.resolved).toEqual([]);
    expect(github.downloads).toEqual([`acme/agents/setups/base@${sha("a")}`]);
  });

  it("fails build with a remote source missing from the lock, and names install", async () => {
    const options = sourceOptions(acme());
    const cwd = project([BASE]);
    const work = tempDir();
    expect(await cli(cwd, ["build", "--out", join(work, "out")], options)).toBe(1);
    expect(output.err).toEqual([
      `.10xagents/10xagents.config.ts: extends[0]: ${BASE} needs a 10xagents.lock: run 10xagents install`,
      "1 error.",
    ]);
    expect(readdirSync(work)).toEqual([]);

    expect(await cli(cwd, ["install"], options)).toBe(0);
    writeFileSync(
      join(cwd, ".10xagents/10xagents.config.ts"),
      configText({ extends: [BASE, "gh:acme/agents/setups/base#v2"] }),
    );
    output.err = [];
    expect(await cli(cwd, ["build", "--out", join(work, "out")], options)).toBe(1);
    expect(output.err).toEqual([
      ".10xagents/10xagents.config.ts: extends[1]: github:acme/agents/setups/base#v2 is not in 10xagents.lock: run 10xagents install",
      "1 error.",
    ]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("drops sources the config no longer lists", async () => {
    const options = sourceOptions(acme());
    const cwd = project([BASE, "github:acme/agents/setups/base#v2"]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect([...lockOf(cwd).keys()]).toHaveLength(2);
    writeFileSync(join(cwd, ".10xagents/10xagents.config.ts"), configText({ extends: [BASE] }));
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect([...lockOf(cwd).keys()]).toEqual([BASE]);
  });

  it("locks a remote setup's own sources, and its relative paths at its commit", async () => {
    const github = fakeGitHub({
      "acme/agents": {
        refs: { main: sha("a") },
        commits: {
          [sha("a")]: {
            "setups/top/10xagents.config.ts": configText({ extends: ["../base"] }),
            "setups/top/traits/tone.md": "---\nsection: how-you-work\n---\nTop tone.\n",
            ...under("setups/base", baseFiles()),
          },
        },
      },
    });
    const options = sourceOptions(github);
    const cwd = project(["github:acme/agents/setups/top#main"]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect([...lockOf(cwd).keys()]).toEqual([
      `github:acme/agents/setups/base#${sha("a")}`,
      "github:acme/agents/setups/top#main",
    ]);
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(promptIn(cwd, "out", "alpha")).toContain("Top tone.");
  });

  it("refuses a remote setup that extends an absolute path or leaves its repository", async () => {
    const github = fakeGitHub({
      "acme/agents": {
        refs: { main: sha("a") },
        commits: {
          [sha("a")]: {
            "top/10xagents.config.ts": configText({ extends: ["/etc", "../../x"] }),
            "top/squad.md": "x\n",
          },
        },
      },
    });
    const cwd = project(["github:acme/agents/top#main"]);
    expect(await cli(cwd, ["install"], sourceOptions(github))).toBe(1);
    expect(output.err.join("\n")).toContain("../../x: leaves the repository acme/agents");
    expect(output.err.join("\n")).toContain(
      "/etc: a setup from GitHub can only extend relative paths",
    );
    expect(existsSync(join(cwd, ".10xagents", LOCK_FILE))).toBe(false);
  });

  it("writes nothing when a source can't be fetched", async () => {
    const cwd = project([BASE, "github:acme/agents/setups/base#nope"]);
    expect(await cli(cwd, ["install"], sourceOptions(acme()))).toBe(1);
    expect(output.err[0]).toBe(
      ".10xagents/10xagents.config.ts: extends[1]: github:acme/agents/setups/base#nope: no ref nope",
    );
    expect(existsSync(join(cwd, ".10xagents", LOCK_FILE))).toBe(false);
  });

  it("fails a subdir the repository doesn't have", async () => {
    const cwd = project(["github:acme/agents/setups/nope#main"]);
    expect(await cli(cwd, ["install"], sourceOptions(acme()))).toBe(1);
    expect(output.err[0]).toBe(
      `.10xagents/10xagents.config.ts: extends[0]: github:acme/agents/setups/nope#${sha("a")}: the repository has no folder setups/nope at ${sha("a")}`,
    );
  });

  it("rewrites a broken lock on install, and build reports it", async () => {
    const options = sourceOptions(acme());
    const cwd = project([BASE], { [LOCK_FILE]: "{ not json" });
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(1);
    expect(output.err[0]).toMatch(/^\.10xagents\/10xagents\.lock: \(json\): /);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect(lockOf(cwd).get(BASE)?.sha).toBe(sha("a"));
  });

  it("refuses to install into a folder with no config, or a remote one", async () => {
    const options = sourceOptions(acme());
    const cwd = tempDir();
    expect(await cli(cwd, ["install"], options)).toBe(1);
    expect(output.err[0]).toBe(
      ".10xagents: (dir): has no 10xagents.config.ts: run 10xagents init, or pass --dir with a setup",
    );
    output.err = [];
    expect(await cli(cwd, ["install", "--dir", BASE], options)).toBe(1);
    expect(output.err.at(-2)).toBe(
      `--dir: ${BASE}: is not a local folder: install writes 10xagents.lock into one`,
    );
  });
});

describe("the cache", () => {
  it("downloads a commit once, then reads it from the cache", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = project([BASE]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(await cli(cwd, ["validate"], options)).toBe(0);
    expect(github.downloads).toEqual([`acme/agents/setups/base@${sha("a")}`]);
  });

  it("downloads a changed cache entry again, and fails when the commit's files differ from the lock", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = project([BASE]);
    expect(await cli(cwd, ["install"], options)).toBe(0);
    const [entry] = readdirSync(join(options.cacheDir, "github/acme/agents"));
    const cached = join(options.cacheDir, "github/acme/agents", entry ?? "");
    writeFileSync(join(cached, "traits/tone.md"), "---\nsection: how-you-work\n---\nTampered.\n");
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(promptIn(cwd, "out", "alpha")).toContain("Base tone.");
    expect(github.downloads).toHaveLength(2);

    // The same commit now serves other files: the lock catches it.
    rmSync(cached, { recursive: true });
    github.repos["acme/agents"]!.commits[sha("a")] = under("setups/base", {
      ...baseFiles(),
      "traits/tone.md": "---\nsection: how-you-work\n---\nSwapped.\n",
    });
    expect(await cli(cwd, ["build", "--out", "out2"], options)).toBe(1);
    expect(output.err[0]).toMatch(/the files' hash is sha256-.*, but 10xagents\.lock has sha256-/);
    expect(existsSync(join(cwd, "out2"))).toBe(false);
  });

  it("refuses a fetched setup that holds a symlink", async () => {
    const options = sourceOptions(acme());
    const source = { kind: "github", owner: "o", repo: "r", subdir: "" } as const;
    const fetcher = {
      resolveRef: () => Promise.resolve(sha("d")),
      download: (_source: unknown, _sha: string, dir: string) => {
        mkdirSync(dir, { recursive: true });
        symlinkSync("/etc/hosts", join(dir, "squad.md"));
        return Promise.resolve();
      },
    };
    await expect(fetchSource(fetcher, options.cacheDir, source, sha("d"))).rejects.toThrow(
      "squad.md is a symlink, which a fetched setup can't hold",
    );
    expect(readdirSync(join(options.cacheDir, "github/o/r"))).toEqual([]);
  });

  it("gives parallel fetches of one commit the same files", async () => {
    const github = acme();
    const { cacheDir } = sourceOptions(github);
    const source = {
      kind: "github",
      owner: "acme",
      repo: "agents",
      subdir: "setups/base",
    } as const;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetchSource(github, cacheDir, source, sha("a"))),
    );
    expect(new Set(results.map((result) => result.hash)).size).toBe(1);
    expect(readdirSync(join(cacheDir, "github/acme/agents"))).toHaveLength(1);
    expect(hashDir(results[0]?.dir ?? "")).toBe(results[0]?.hash);
  });

  it("cleans up when a download fails", async () => {
    const { cacheDir } = sourceOptions(acme());
    const source = { kind: "github", owner: "o", repo: "r", subdir: "" } as const;
    const fetcher = {
      resolveRef: () => Promise.resolve(sha("e")),
      download: (_source: unknown, _sha: string, dir: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "half"), "");
        return Promise.reject(new SourceError("network down"));
      },
    };
    await expect(fetchSource(fetcher, cacheDir, source, sha("e"))).rejects.toThrow("network down");
    expect(readdirSync(join(cacheDir, "github/o/r"))).toEqual([]);
  });
});

describe("a remote --dir", () => {
  it("resolves the ref now and prints the commit", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = tempDir();
    expect(await cli(cwd, ["build", "--dir", BASE, "--out", "out"], options)).toBe(0);
    expect(output.err).toEqual([`Resolved ${BASE} to ${sha("a")}.`]);
    expect(promptIn(cwd, "out", "alpha")).toContain("Base tone.");
  });

  it("names a fetched file by its source and commit, not its place in the cache", async () => {
    const github = acme({ ...baseFiles(), "traits/tone.md": "---\nsection: nope\n---\nX.\n" });
    expect(await cli(tempDir(), ["validate", "--dir", BASE], sourceOptions(github))).toBe(1);
    expect(output.err).toContain(
      `github:acme/agents/setups/base#${sha("a")}/agents/alpha.yaml: traits[0]: trait tone fills slot nope, which template default doesn't have`,
    );
  });

  it("takes gh: and a commit SHA, which needs no resolving", async () => {
    const github = acme();
    const cwd = tempDir();
    expect(
      await cli(
        cwd,
        ["validate", "--dir", `gh:acme/agents/setups/base#${sha("b")}`],
        sourceOptions(github),
      ),
    ).toBe(0);
    expect(github.resolved).toEqual([]);
    expect(output.err).toEqual([
      `Resolved github:acme/agents/setups/base#${sha("b")} to ${sha("b")}.`,
    ]);
  });

  it("names a ref GitHub doesn't have", async () => {
    const cwd = tempDir();
    expect(
      await cli(cwd, ["validate", "--dir", "github:acme/agents#nope"], sourceOptions(acme())),
    ).toBe(1);
    expect(output.err[0]).toBe("--dir: (source): github:acme/agents#nope: no ref nope");
  });
});

describe("init", () => {
  it("writes a config with no import, a starter target and the lock, which validate passes", async () => {
    const bundled = writeSetup(under("kit", baseFiles()));
    const options = sourceOptions(acme(), bundled);
    const cwd = join(tempDir(), "My Project");
    mkdirSync(cwd);
    expect(await cli(cwd, ["init", "--from", "kit"], options)).toBe(0);
    const config = readFileSync(join(cwd, ".10xagents/10xagents.config.ts"), "utf8");
    expect(config).not.toMatch(/\bimport\b/);
    expect(config).toContain('extends: ["kit"]');
    expect(config).toContain('target: "my-project"');
    expect(readFileSync(join(cwd, ".10xagents/targets/my-project/target.yaml"), "utf8")).toBe(
      [
        "id: my-project",
        "connector: fake",
        "workflows:",
        "  - flow",
        "agents:",
        "  - alpha",
        "  - beta",
        "vars:",
        "  owner: Sam",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(cwd, ".10xagents", LOCK_FILE), "utf8")).toBe(
      '{\n  "lockfileVersion": 1,\n  "sources": {}\n}\n',
    );
    expect(output.out.at(-1)).toBe(
      "The setup extends kit, with the starter target my-project. Run 10xagents validate next.",
    );
    expect(await cli(cwd, ["validate"], options)).toBe(0);
    expect(await cli(cwd, ["build", "--out", "out"], options)).toBe(0);
    expect(output.out.at(-1)).toMatch(/^Built target my-project:/);
  });

  it("extends starter by default", async () => {
    const bundled = writeSetup(under("starter", baseFiles()));
    const cwd = tempDir();
    expect(await cli(cwd, ["init", "--target", "main"], sourceOptions(acme(), bundled))).toBe(0);
    expect(readFileSync(join(cwd, ".10xagents/10xagents.config.ts"), "utf8")).toContain(
      'extends: ["starter"]',
    );
  });

  it("writes a local --from relative to the setup's folder, and locks a GitHub one", async () => {
    const github = acme();
    const options = sourceOptions(github);
    const cwd = writeSetup(under("shared", baseFiles()));
    expect(await cli(cwd, ["init", "--from", "shared", "--target", "x"], options)).toBe(0);
    expect(readFileSync(join(cwd, ".10xagents/10xagents.config.ts"), "utf8")).toContain(
      'extends: ["../shared"]',
    );
    expect(await cli(cwd, ["validate"], options)).toBe(0);

    const other = tempDir();
    expect(
      await cli(other, ["init", "--from", "gh:acme/agents/setups/base", "--target", "x"], options),
    ).toBe(0);
    const config = readFileSync(join(other, ".10xagents/10xagents.config.ts"), "utf8");
    expect(config).toContain('extends: ["github:acme/agents/setups/base"]');
    expect(lockOf(other).get("github:acme/agents/setups/base")?.sha).toBe(sha("a"));
    expect(await cli(other, ["build", "--out", "out"], options)).toBe(0);
  });

  it("writes nothing over an existing setup, or when the source fails", async () => {
    const bundled = writeSetup(under("kit", baseFiles()));
    const options = sourceOptions(acme(), bundled);
    const cwd = project(["kit"]);
    expect(await cli(cwd, ["init", "--from", "kit"], options)).toBe(1);
    expect(output.err[0]).toBe(
      ".10xagents/10xagents.config.ts: (file): already exists: init writes a new setup only",
    );

    const empty = tempDir();
    output.err = [];
    expect(await cli(empty, ["init", "--from", "nope"], options)).toBe(1);
    expect(output.err[0]).toBe("--from: extends[0]: nope: no bundled setup nope. Bundled: kit");
    expect(readdirSync(empty)).toEqual([]);
  });

  it("writes a config that loads from a folder with no node_modules", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "10xagents.config.ts"),
      configText({ extends: ["ultracode", "github:o/r#main"], target: "t" }),
    );
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    const diagnostics = new Diagnostics();
    const loaded = await loadConfig(dir, diagnostics);
    expect(diagnostics.list).toEqual([]);
    expect(loaded.config).toEqual({
      extends: ["ultracode", "github:o/r#main"],
      target: "t",
      connectors: {},
    });
  });
});

describe("githubFetcher", () => {
  const source = {
    kind: "github",
    owner: "acme",
    repo: "agents",
    subdir: "setups/base",
    ref: "feature/x",
  } as const;

  it("asks GitHub's API for the ref's commit, with GITHUB_TOKEN", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetcher = githubFetcher({
      token: "t0ken",
      fetch: (url, init) => {
        calls.push({ url: urlOf(url), headers: new Headers(init?.headers) });
        return Promise.resolve(new Response(`${sha("f")}\n`));
      },
    });
    expect(await fetcher.resolveRef(source)).toBe(sha("f"));
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/agents/commits/feature/x");
    expect(calls[0]?.headers.get("accept")).toBe("application/vnd.github.sha");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer t0ken");
  });

  it("reads GITHUB_TOKEN when it's used, and sends none without it", async () => {
    const seen: (string | null)[] = [];
    const fetcher = githubFetcher({
      fetch: (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(new Response(sha("f")));
      },
    });
    const saved = process.env["GITHUB_TOKEN"];
    try {
      delete process.env["GITHUB_TOKEN"];
      await fetcher.resolveRef(source);
      process.env["GITHUB_TOKEN"] = "later";
      await fetcher.resolveRef(source);
    } finally {
      if (saved === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = saved;
    }
    expect(seen).toEqual([null, "Bearer later"]);
  });

  it("hints at GITHUB_TOKEN when the repository isn't found, and never prints the token", async () => {
    await expect(notFound().resolveRef(source)).rejects.toThrow(
      "no repository acme/agents with the ref feature/x. If the repository is private, set GITHUB_TOKEN.",
    );
    const error = await notFound("s3cret")
      .resolveRef(source)
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("s3cret");
    const garbage = githubFetcher({
      token: undefined,
      fetch: () => Promise.resolve(new Response("<html>")),
    });
    await expect(garbage.resolveRef(source)).rejects.toThrow("GitHub answered with no commit SHA");
  });

  it("downloads with giget at the commit, with the token as auth", async () => {
    const calls: unknown[] = [];
    const fetcher = githubFetcher({
      token: "t0ken",
      downloadTemplate: (input, options) => {
        calls.push([input, options]);
        return Promise.resolve();
      },
    });
    await fetcher.download(source, sha("f"), "/somewhere");
    expect(calls).toEqual([
      [
        `github:acme/agents/setups/base#${sha("f")}`,
        { dir: "/somewhere", registry: false, silent: true, auth: "t0ken" },
      ],
    ]);
  });
});

describe("hashDir", () => {
  it("changes with a file's name or bytes, and not with the folder's place", () => {
    const one = writeSetup({ "a.md": "x", "b/c.md": "y" });
    const two = writeSetup({ "a.md": "x", "b/c.md": "y" });
    expect(hashDir(one)).toBe(hashDir(two));
    writeFileSync(join(two, "b/c.md"), "z");
    expect(hashDir(one)).not.toBe(hashDir(two));
    const three = writeSetup({ "a.md": "x", "b/d.md": "y" });
    expect(hashDir(one)).not.toBe(hashDir(three));
    chmodSync(join(one, "a.md"), 0o600);
    expect(hashDir(one)).toBe(hashDir(writeSetup({ "a.md": "x", "b/c.md": "y" })));
  });
});
