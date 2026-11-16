import type { RenderedSetup } from "10xagents";
import { describe, expect, it } from "vitest";

import { columnNames } from "../src/index.ts";
import {
  baseFiles,
  fake,
  freshState,
  issuesOf,
  planWith,
  render,
  syncWith,
  toApply,
} from "./helpers.ts";
import type { Files } from "./helpers.ts";

/** The base setup plus a second workflow, `part`, on the same target. */
const twoWorkflows = (
  blocked = "{ key: blocked, handoff: owner }",
  blockedStep?: string,
): Files => ({
  ...baseFiles(),
  "workflows/part/workflow.yaml": [
    "id: part",
    "entry: planning",
    "columns:",
    '  - { key: planning, name: Planning, handoff: "agent:beta", next: in_progress, back: blocked }',
    "  - { key: in_progress, handoff: none }",
    `  - ${blocked}`,
    "  - { key: done, handoff: none }",
    "  - { key: cancelled, handoff: none }",
    "",
  ].join("\n"),
  "workflows/part/steps/planning.md":
    "Plan the part, then send it on from {{workflows.part.columns.planning}}.\n",
  ...(blockedStep === undefined ? {} : { "workflows/part/steps/blocked.md": blockedStep }),
  "targets/t/target.yaml":
    baseFiles()["targets/t/target.yaml"]?.replace(
      "workflows: [request]",
      "workflows: [request, part]",
    ) ?? null,
});

/** `files` with `prefix` on the `part` workflow, and its `planning` column's name set to `name`. */
const withPrefix = (files: Files, prefix: string, name = "Planning"): Files => ({
  ...files,
  "workflows/part/workflow.yaml":
    files["workflows/part/workflow.yaml"]
      ?.replace("entry: planning", `entry: planning\nprefix: "${prefix}"`)
      .replace("name: Planning", `name: ${name}`) ?? null,
});

describe("columnNames", () => {
  it("keeps the first workflow's names, prefixes later ones' custom columns and uses Multica's built-in names", () => {
    const names = columnNames([
      {
        id: "request",
        entry: "todo",
        columns: [
          { key: "todo", name: "To do", handoff: "none" },
          { key: "plan_review", handoff: "none" },
          { key: "planning", name: "Planning", handoff: "none" },
        ],
      },
      {
        id: "part",
        entry: "planning",
        columns: [
          { key: "planning", name: "Planning", handoff: "none" },
          { key: "in_progress", handoff: "none" },
        ],
      },
    ]);
    expect(names).toEqual({
      request: { todo: "Todo", plan_review: "Plan Review", planning: "Planning" },
      part: { planning: "Part Planning", in_progress: "In Progress" },
    });
  });

  it("puts a later workflow's prefix before its custom columns, and ignores the first one's", () => {
    const names = columnNames([
      {
        id: "request",
        entry: "todo",
        prefix: "Request /",
        columns: [
          { key: "todo", handoff: "none" },
          { key: "planning", name: "Planning", handoff: "none" },
        ],
      },
      {
        id: "part",
        entry: "planning",
        prefix: "In Parts /",
        columns: [
          { key: "planning", name: "Planning", handoff: "none" },
          { key: "quality_assurance", handoff: "none" },
          { key: "in_progress", handoff: "none" },
        ],
      },
    ]);
    expect(names).toEqual({
      request: { todo: "Todo", planning: "Planning" },
      part: {
        planning: "In Parts / Planning",
        quality_assurance: "In Parts / Quality Assurance",
        in_progress: "In Progress",
      },
    });
  });
});

describe("two workflows", () => {
  it("merge into one Default workflow, with namespaced statuses", async () => {
    const rendered = render(twoWorkflows());
    expect(issuesOf(rendered)).toEqual([]);
    expect(rendered.workflows[1]?.columns[0]?.instructions).toBe(
      "Plan the part, then send it on from Part Planning.",
    );
    const multica = fake();
    const { failed } = await syncWith(rendered, multica.env);
    expect(failed).toEqual([]);
    const steps = multica.state().workflows[0]?.steps ?? [];
    expect(steps.map((step) => step.status_key)).toEqual([
      "backlog",
      "todo",
      "planning",
      "plan_approval",
      "in_progress",
      "part_planning",
      "blocked",
      "done",
      "cancelled",
    ]);
    expect(steps[5]).toMatchObject({
      handler: { type: "agent", id: "ag-beta" },
      instructions: "Plan the part, then send it on from Part Planning.",
      next_status_key: "in_progress",
      back_status_key: "blocked",
    });
    expect(toApply((await planWith(rendered, multica.env)).changes)).toEqual([]);
  });

  it("keep a renamed status's key when the workflow's prefix matches its new name", async () => {
    const rendered = render(withPrefix(twoWorkflows(), "In Parts /"));
    expect(issuesOf(rendered)).toEqual([]);
    expect(rendered.workflows[1]?.columns[0]?.instructions).toBe(
      "Plan the part, then send it on from In Parts / Planning.",
    );
    // A workspace whose part status was renamed to the prefixed name, keeping its key.
    const statuses = [
      { key: "planning", name: "Planning", category: "started" },
      { key: "plan_approval", name: "Plan Approval", category: "started" },
      { key: "part_planning", name: "In Parts / Planning", category: "started" },
    ];
    const multica = fake({ ...freshState(), statuses });
    const { failed } = await syncWith(rendered, multica.env);
    expect(failed).toEqual([]);
    expect(multica.state().statuses).toEqual(statuses);
    const steps = multica.state().workflows[0]?.steps ?? [];
    expect(steps.map((step) => step.status_key)).toEqual([
      "backlog",
      "todo",
      "planning",
      "plan_approval",
      "in_progress",
      "part_planning",
      "blocked",
      "done",
      "cancelled",
    ]);
    expect(steps[5]).toMatchObject({
      handler: { type: "agent", id: "ag-beta" },
      instructions: "Plan the part, then send it on from In Parts / Planning.",
      next_status_key: "in_progress",
      back_status_key: "blocked",
    });
    expect(toApply((await planWith(rendered, multica.env)).changes)).toEqual([]);
  });

  it("fail validate when a prefix gives a column another column's name", () => {
    const issues = issuesOf(render(withPrefix(twoWorkflows(), "Plan", "Approval")));
    expect(issues).toEqual([
      "workflows.part.columns.planning.name: Plan Approval is also the name of workflow request's plan_approval: Multica names a status once",
    ]);
  });

  it.each([
    ["handoff", "{ key: blocked, handoff: none }", undefined, "handoff"],
    ["step text", "{ key: blocked, handoff: owner }", "Wait for the owner.\n", "step text"],
    ["back move", "{ key: blocked, handoff: owner, back: planning }", undefined, "back"],
    ["next move", "{ key: blocked, handoff: owner, next: done }", undefined, "next"],
  ])("fail validate when they give a shared column another %s", (_, blocked, step, what) => {
    const issues = issuesOf(render(twoWorkflows(blocked, step)));
    expect(issues).toEqual([
      `workflows.part.columns.blocked: Blocked is shared with workflow request, which gives it another ${what}: Multica has one Blocked, so give both the same`,
    ]);
  });
});

/** A rendered setup with one change made to it. */
const changed = (change: (rendered: RenderedSetup) => void): RenderedSetup => {
  const rendered = render();
  change(rendered);
  return rendered;
};

/** The issues for an agent description of `size` characters. */
const withDescription = (size: number, character = "é"): string[] =>
  issuesOf(
    changed((rendered) => {
      const agent = rendered.agents[0];
      if (agent) agent.description = character.repeat(size);
    }),
  );

/** The issues for a Todo step of `size` characters. */
const withStep = (size: number): string[] =>
  issuesOf(
    changed((rendered) => {
      const column = rendered.workflows[0]?.columns[1];
      if (column) column.instructions = "x".repeat(size);
    }),
  );

describe("validate", () => {
  it("passes the base setup", () => {
    expect(issuesOf(render())).toEqual([]);
  });

  it("takes a 255-character description and refuses 256", () => {
    expect(withDescription(255)).toEqual([]);
    expect(withDescription(256)).toEqual([
      "agents.alpha.description: is 256 characters, over Multica's 255",
    ]);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(withDescription(255, "😀")).toEqual([]);
    expect(withDescription(256, "😀")).toEqual([
      "agents.alpha.description: is 256 characters, over Multica's 255",
    ]);
  });

  it("refuses a squad whose instructions render empty", () => {
    expect(issuesOf(render({ ...baseFiles(), "squad.md": null }))).toEqual([
      "squad.instructions: renders empty: add squad.md to the setup or the target, or point squad.instructions at a file",
    ]);
  });

  it("takes an 8000-character step and refuses 8001", () => {
    expect(withStep(8000)).toEqual([]);
    expect(withStep(8001)).toEqual([
      "workflows.request.steps.todo: is 8001 characters, over Multica's 8000",
    ]);
  });

  it("refuses fixed columns out of Multica's order", () => {
    const issues = issuesOf(
      changed((rendered) => {
        const workflow = rendered.workflows[0];
        if (workflow)
          workflow.columns = [
            ...workflow.columns.slice(1, 3),
            workflow.columns[0]!,
            ...workflow.columns.slice(3),
          ];
      }),
    );
    expect(issues).toEqual([
      "workflows.request.columns: list backlog and todo first, and blocked, done and cancelled last, as Multica does",
    ]);
    const late = issuesOf(
      changed((rendered) => {
        const workflow = rendered.workflows[0];
        // Blocked before Planning.
        if (workflow) {
          const [backlog, todo, planning, approval, progress, blocked, ...rest] = workflow.columns;
          workflow.columns = [backlog!, todo!, blocked!, planning!, approval!, progress!, ...rest];
        }
      }),
    );
    expect(late).toHaveLength(1);
  });

  it("needs todo, done and cancelled", () => {
    const issues = issuesOf(
      changed((rendered) => {
        const workflow = rendered.workflows[0];
        if (workflow) workflow.columns = workflow.columns.filter((column) => column.key !== "done");
      }),
    );
    expect(issues).toEqual(["workflows: no workflow has a done column, and Multica needs one"]);
  });

  it("refuses a handoff in Backlog, Done or Cancelled", () => {
    const issues = issuesOf(
      changed((rendered) => {
        const done = rendered.workflows[0]?.columns.find((column) => column.key === "done");
        if (done) done.handoff = "owner";
      }),
    );
    expect(issues).toEqual([
      "workflows.request.columns.done.handoff: Multica hands nothing off in Done: make it none",
    ]);
  });

  it("refuses a custom column named like a built-in status, or like another column", () => {
    const issues = issuesOf(
      changed((rendered) => {
        const columns = rendered.workflows[0]?.columns ?? [];
        if (columns[2]) columns[2].name = "Done";
        if (columns[3]) columns[3].name = "planning";
      }),
    );
    expect(issues).toEqual([
      "workflows.request.columns.planning.name: Done is the name of a built-in Multica status",
    ]);
    const twice = issuesOf(
      changed((rendered) => {
        const columns = rendered.workflows[0]?.columns ?? [];
        if (columns[3]) columns[3].name = "planning";
      }),
    );
    expect(twice).toEqual([
      "workflows.request.columns.plan_approval.name: planning is also the name of workflow request's planning: Multica names a status once",
    ]);
  });
});
