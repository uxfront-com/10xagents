import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildFiles, stableJson } from "../src/build.ts";
import { baseSetup, FIXTURES, promptOf, renderOk, run } from "./helpers.ts";
import type { Files } from "./helpers.ts";

const target = (lines: string[]): Files => ({
  "targets/t/target.yaml": [
    "id: t",
    "connector: fake",
    "workflows: [flow]",
    "agents: [alpha, beta]",
    "vars: { owner: Sam }",
    ...lines,
    "",
  ].join("\n"),
});

const globals: Files = {
  "traits/global/02-second.md": "Shared two.\n",
  "traits/global/01-first.md": "Shared one, for {{vars.owner}}.\n",
  "targets/t/traits/global/00-own.md": "Own zero.\n",
  "targets/t/traits/global/03-own.md": "Own three.\n",
};

const ALPHA = baseSetup()["agents/alpha.yaml"] ?? "";

/** A template that titles the prompt with `title`. */
const titled = (title: string) =>
  `---\nslots:\n  role: { required: true }\n  handback: {}\n---\n${title}\n\n{{slot:role}}\n\n{{slot:handback}}\n`;

/** The squad instructions a setup renders. */
const squadOf = (files: Files) => renderOk({ ...baseSetup(), ...files }).squad?.instructions;

describe("render", () => {
  it("leaves out an empty optional slot, heading included", () => {
    const prompt = promptOf(renderOk(baseSetup()), "alpha");
    expect(prompt).toBe(
      "# Alpha\n\n## Role\n\nYou're the Alpha.\n\n## What you hand back\n\nThe result.",
    );
    expect(prompt).not.toContain("## How you work");
  });

  it("orders globals by file name, the setup's before the target's own", () => {
    const rendered = renderOk({ ...baseSetup(), ...globals }, { sharedContext: true });
    expect(rendered.sharedContext).toBe(
      "Shared one, for Sam.\n\nShared two.\n\nOwn zero.\n\nOwn three.",
    );
  });

  it("appends globals at the end without {{global}} and without a shared context", () => {
    const rendered = renderOk({
      ...baseSetup(),
      ...globals,
      "templates/default.md":
        "---\nslots:\n  role: { heading: Role, required: true }\n  handback: {}\n---\n# {{agent.name}}\n\n{{slot:role}}\n\n{{slot:handback}}\n",
    });
    expect(promptOf(rendered, "alpha")).toBe(
      "# Alpha\n\n## Role\n\nYou're the Alpha.\n\nThe result.\n\nShared one, for Sam.\n\nShared two.\n\nOwn zero.\n\nOwn three.",
    );
    expect(rendered.sharedContext).toBe("");
  });

  it("renders globals at {{global}} without a shared context, and nothing there with one", () => {
    const files = { ...baseSetup(), ...globals };
    const inline = promptOf(renderOk(files), "alpha");
    expect(inline).toBe(
      "# Alpha\n\n## Role\n\nYou're the Alpha.\n\n## What you hand back\n\nThe result.\n\nShared one, for Sam.\n\nShared two.\n\nOwn zero.\n\nOwn three.",
    );
    const shared = renderOk(files, { sharedContext: true });
    expect(promptOf(shared, "alpha")).toBe(
      "# Alpha\n\n## Role\n\nYou're the Alpha.\n\n## What you hand back\n\nThe result.",
    );
  });

  it("uses the built-in default with no template set", () => {
    const rendered = renderOk(baseSetup());
    expect(rendered.agents.map((agent) => agent.template)).toEqual(["default", "default"]);
    expect(promptOf(rendered, "alpha")).toMatch(/^# Alpha\n\n## Role\n\n/);
  });

  it("lets a setup's templates/default.md replace the built-in default", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "templates/default.md":
        "---\nslots:\n  role: { heading: Who, required: true }\n  handback: { heading: Output }\n---\n{{agent.name}} prompt\n\n{{slot:role}}\n\n{{slot:handback}}\n",
    });
    expect(promptOf(rendered, "alpha")).toBe(
      "Alpha prompt\n\n## Who\n\nYou're the Alpha.\n\n## Output\n\nThe result.",
    );
  });

  it("resolves templates in order: the agent's, the target's, the setup's default, the built-in", () => {
    const files: Files = {
      ...baseSetup(),
      "agents/alpha.yaml": ALPHA.replace("concurrency: 1", "concurrency: 1\ntemplate: short"),
      "templates/short.md": titled("Setup short"),
      "targets/t/templates/short.md": titled("Target short"),
      "templates/wide.md": titled("Wide"),
      ...target(["template: wide"]),
    };
    const rendered = renderOk(files);
    expect(promptOf(rendered, "alpha").split("\n")[0]).toBe("Target short");
    expect(promptOf(rendered, "beta").split("\n")[0]).toBe("Wide");
  });

  it("looks traits up in the target's folder first", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "agents/alpha.yaml": ALPHA.replace("concurrency: 1", "concurrency: 1\ntraits: [care]"),
      "traits/care.md": "---\nsection: boundaries\n---\nShared care.\n",
      "targets/t/traits/care.md": "---\nsection: boundaries\n---\nTarget care.\n",
    });
    expect(promptOf(rendered, "alpha")).toContain("## Boundaries\n\nTarget care.");
  });

  it("fills a slot with the agent's sections, then its traits in order, with params", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "agents/alpha.yaml": [
        "id: alpha",
        "name: Alpha",
        "description: d",
        "model: { id: m, thinking: low }",
        "concurrency: 1",
        "sections:",
        "  role: R.",
        "  how-you-work: |",
        "    Own text.",
        "  handback: H.",
        "traits:",
        "  - second",
        "  - { id: first, params: { tone: dry, count: 2, loud: false } }",
        "",
      ].join("\n"),
      "traits/first.md":
        "---\nsection: how-you-work\nparams:\n  tone: string\n  count: number\n  loud: boolean\n  extra: { type: string, default: none }\n---\nTone {{params.tone}}, {{params.count}}, {{params.loud}}, {{params.extra}}.\n",
      "traits/second.md": "---\nsection: how-you-work\n---\n\n\nSecond.\n\n\n",
    });
    expect(promptOf(rendered, "alpha")).toContain(
      "## How you work\n\nOwn text.\n\nSecond.\n\nTone dry, 2, false, none.\n\n## What",
    );
  });

  it("ends without a trailing newline, whatever the sources end with", () => {
    const rendered = renderOk(
      {
        ...baseSetup(),
        "agents/alpha.yaml": ALPHA.replace(
          "  handback: The result.",
          "  handback: |+\n    The result.\n\n\n",
        ),
        "traits/global/01-a.md": "Global.\n\n\n",
        "workflows/flow/steps/todo.md": "Start.\r\n\r\n",
        "squad.md": "Squad.\n\n",
        ...target(["squad: { name: S, leader: alpha }"]),
      },
      { sharedContext: true },
    );
    const texts = [
      ...rendered.agents.map((agent) => agent.instructions),
      rendered.sharedContext,
      rendered.squad?.instructions ?? "",
      ...rendered.workflows.flatMap((workflow) =>
        workflow.columns.map((column) => column.instructions ?? "x"),
      ),
    ];
    for (const text of texts) expect(text).not.toMatch(/\s$/);
    expect(promptOf(rendered, "alpha").endsWith("The result.")).toBe(true);
    for (const [path, content] of buildFiles(rendered)) {
      if (path.endsWith(".md")) expect(content).not.toMatch(/\n$/);
    }
  });

  it("puts squad.role and the leader in the rendered squad", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "squad.md": "Work together, {{vars.owner}}.\n",
      ...target(["squad: { name: Crew, leader: beta }"]),
    });
    expect(rendered.squad).toEqual({
      name: "Crew",
      leader: "beta",
      instructions: "Work together, Sam.",
      members: { alpha: "member", beta: "Reviews the work." },
    });
    expect(buildFiles(rendered).get("squad.md")).toBe(
      "---\nleader: beta\nmembers:\n  alpha: member\n  beta: Reviews the work.\nname: Crew\n---\n\nWork together, Sam.",
    );
  });

  it("takes squad instructions from the target's file, then its squad.md, then the setup's", () => {
    const leader = target(["squad: { name: S, leader: alpha }"]);
    expect(squadOf({ ...leader })).toBe("");
    expect(squadOf({ ...leader, "squad.md": "Setup." })).toBe("Setup.");
    expect(squadOf({ ...leader, "squad.md": "Setup.", "targets/t/squad.md": "Target." })).toBe(
      "Target.",
    );
    expect(
      squadOf({
        ...target(["squad: { name: S, leader: alpha, instructions: crew.md }"]),
        "targets/t/squad.md": "Target.",
        "targets/t/crew.md": "Crew file.",
      }),
    ).toBe("Crew file.");
  });

  it("changes only the global trait a replace override names", () => {
    const files = { ...baseSetup(), ...globals };
    const before = renderOk(files, { sharedContext: true }).sharedContext;
    const after = renderOk(
      {
        ...files,
        ...target(["overrides:", "  traits.global.02-second: { replace: two.md }"]),
        "targets/t/two.md": "Replaced two, for {{vars.owner}}.\n",
      },
      { sharedContext: true },
    ).sharedContext;
    expect(before.split("\n\n")).toEqual([
      "Shared one, for Sam.",
      "Shared two.",
      "Own zero.",
      "Own three.",
    ]);
    expect(after.split("\n\n")).toEqual([
      "Shared one, for Sam.",
      "Replaced two, for Sam.",
      "Own zero.",
      "Own three.",
    ]);
  });

  it("appends to a step and to an opt-in trait with one blank line, and replaces a step", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "agents/alpha.yaml": ALPHA.replace("concurrency: 1", "concurrency: 1\ntraits: [care]"),
      "traits/care.md": "---\nsection: boundaries\n---\nCare.\n",
      ...target([
        "overrides:",
        "  workflows.flow.steps.todo: { append: more.md }",
        "  workflows.flow.steps.review: { replace: more.md }",
        "  workflows.flow.steps.blocked: { replace: more.md }",
        "  traits.care: { append: more.md }",
      ]),
      "targets/t/more.md": "\nMore for {{vars.owner}}.\n\n",
    });
    const columns = rendered.workflows[0]?.columns ?? [];
    expect(columns.map((column) => column.instructions)).toEqual([
      "Start the work.\n\nMore for Sam.",
      "More for Sam.",
      "More for Sam.",
      undefined,
    ]);
    expect(promptOf(rendered, "alpha")).toContain("## Boundaries\n\nCare.\n\nMore for Sam.");
  });

  it("renders workflow references with the connector's column names", () => {
    const rendered = renderOk(
      {
        ...baseSetup(),
        "workflows/flow/steps/todo.md":
          "Go to {{workflows.flow.columns.review}} from {{workflows.flow.entry}}.\n",
      },
      {
        columnNames: (workflows) =>
          Object.fromEntries(
            workflows.map((workflow) => [
              workflow.id,
              Object.fromEntries(
                workflow.columns.map((column) => [column.key, `Flow ${column.name ?? column.key}`]),
              ),
            ]),
          ),
      },
    );
    const todo = rendered.workflows[0]?.columns[0];
    expect(todo?.instructions).toBe("Go to Flow Review from Flow To do.");
    expect(todo?.name).toBe("Flow To do");
  });

  it("names a column by its key when it has no name", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "workflows/flow/steps/todo.md": "{{workflows.flow.columns.todo}}\n",
      "workflows/flow/workflow.yaml": baseSetup()["workflows/flow/workflow.yaml"]!.replace(
        "key: todo, name: To do,",
        "key: todo,",
      ),
    });
    expect(rendered.workflows[0]?.columns[0]?.instructions).toBe("todo");
  });

  it("sets the workspace to the target's id unless target.yaml names one", () => {
    expect(renderOk(baseSetup()).target.workspace).toBe("t");
    expect(renderOk({ ...baseSetup(), ...target(["workspace: acme"]) }).target.workspace).toBe(
      "acme",
    );
  });

  it("leaves a template's indentation, and keeps a code block whole", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "agents/alpha.yaml": ALPHA.replace(
        "  role: You're the Alpha.",
        "  role: |\n    Run:\n\n    ```bash\n    a\n\n    b\n    ```",
      ),
    });
    expect(promptOf(rendered, "alpha")).toContain(
      "## Role\n\nRun:\n\n```bash\na\n\nb\n```\n\n## What",
    );
  });
});

describe("build files", () => {
  it("writes the same bytes for the same setup", () => {
    const dir = join(FIXTURES, "ok");
    const first = run(dir, "ok", { sharedContext: true });
    const second = run(dir, "ok", { sharedContext: true });
    expect(first.errors).toEqual([]);
    expect(first.rendered).toBeDefined();
    expect(second.rendered).toBeDefined();
    if (!first.rendered || !second.rendered) return;
    expect([...buildFiles(first.rendered)]).toEqual([...buildFiles(second.rendered)]);
    expect([...buildFiles(first.rendered).keys()].toSorted()).toEqual([
      "agents/builder.md",
      "agents/lead.md",
      "agents/planner.md",
      "shared-context.md",
      "squad.md",
      "workflows/request.json",
    ]);
  });

  it("leaves out shared-context.md and squad.md when there's nothing to write", () => {
    const files = buildFiles(renderOk(baseSetup()));
    expect([...files.keys()]).toEqual(["agents/alpha.md", "agents/beta.md", "workflows/flow.json"]);
  });

  it("sorts every key in JSON", () => {
    expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it("renders a large setup", () => {
    const files: Files = { ...baseSetup() };
    const ids: string[] = [];
    for (let index = 0; index < 300; index++) {
      const id = `agent-${index}`;
      ids.push(id);
      files[`agents/${id}.yaml`] = ALPHA.replace("id: alpha", `id: ${id}`).replace(
        "You're the Alpha.",
        "Long text. ".repeat(2000),
      );
    }
    files["targets/t/target.yaml"] =
      `id: t\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta, ${ids.join(", ")}]\n`;
    const rendered = renderOk(files);
    expect(rendered.agents).toHaveLength(302);
  });
});

/** A skill's folder, from the setup's root. */
const where = (dir: string): string =>
  dir.slice(dir.lastIndexOf("10xagents-")).replace(/^[^/]+\//, "");

describe("skills", () => {
  it("lists the setup's skills and the target's own, sorted, with the target's replacing the setup's", () => {
    const rendered = renderOk({
      ...baseSetup(),
      "skills/writing/SKILL.md": "setup\n",
      "skills/shared/SKILL.md": "setup\n",
      "targets/t/skills/shared/SKILL.md": "target\n",
      "targets/t/skills/alone/SKILL.md": "target\n",
      "skills/not-a-folder.md": "ignored\n",
    });
    expect(rendered.skills.map((skill) => [skill.name, where(skill.dir)])).toEqual([
      ["alone", "targets/t/skills/alone"],
      ["shared", "targets/t/skills/shared"],
      ["writing", "skills/writing"],
    ]);
  });

  it("is empty when the setup has none", () => {
    expect(renderOk(baseSetup()).skills).toEqual([]);
  });
});
