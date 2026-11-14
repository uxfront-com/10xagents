import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Diagnostics, formatDiagnostic } from "../src/diagnostics.ts";
import { loadSetup } from "../src/loader.ts";
import { validateSetup } from "../src/validate.ts";
import { baseSetup, errorsOf, FIXTURES, run, writeSetup } from "./helpers.ts";

const validate = (dir: string): string[] => {
  const diagnostics = new Diagnostics();
  validateSetup(loadSetup(dir, diagnostics), diagnostics);
  return diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, dir));
};

const withAgent = (yaml: string, extra: Record<string, string> = {}) => ({
  ...baseSetup(),
  "agents/alpha.yaml": yaml,
  ...extra,
});

const agent = (lines: string[]): string =>
  [
    "id: alpha",
    "name: Alpha",
    "description: An agent for tests.",
    "model: { id: test-model, thinking: low }",
    "concurrency: 1",
    ...lines,
    "",
  ].join("\n");

const okSections = ["sections:", "  role: You're Alpha.", "  handback: The result."];

/** The base setup, with Alpha's description set to `text`. */
const withDescription = (text: string) =>
  withAgent(
    agent(okSections).replace("description: An agent for tests.", `description: "${text}"`),
  );

describe("validate", () => {
  it("passes the ok fixture", () => {
    expect(validate(join(FIXTURES, "ok"))).toEqual([]);
  });

  it("passes the base setup", () => {
    expect(run(writeSetup(baseSetup())).errors).toEqual([]);
  });

  it("reports each broken fixture once, naming its file and field", () => {
    expect(validate(join(FIXTURES, "broken")).toSorted()).toEqual(
      [
        "agents/empty-required.yaml: sections.handback: is empty, and template default requires it",
        "agents/long-description.yaml: description: must be at most 255 characters (it has 256)",
        "agents/missing-template.yaml: template: no template missing in targets/broken/templates/, templates/ or the built-ins",
        "agents/missing-trait.yaml: traits[0]: no trait nope in targets/broken/traits/ or traits/",
        "agents/slot-missing.yaml: traits[0]: trait aside fills slot aside, which template default doesn't have",
        "agents/undefined-var.yaml: sections.role: {{vars.nobody}} is not defined by target broken",
        "agents/unknown-column.yaml: sections.role: {{workflows.flow.columns.nowhere}} names a column workflow flow doesn't have",
        "agents/unknown-param.yaml: traits[0].params.loudness: trait tone has no param loudness",
        "agents/unknown-workflow.yaml: sections.role: {{workflows.nowhere.entry}} names a workflow target broken doesn't use",
        "targets/broken/target.yaml: squad.leader: ghost is not one of the target's agents",
        "workflows/flow/workflow.yaml: columns[1]: column review has no way out: it hands off to an agent, so it needs next",
        "workflows/flow/workflow.yaml: columns[3].key: done is a duplicate key (columns[2] has it too)",
      ].toSorted(),
    );
  });

  describe("traits, params and vars", () => {
    it("reports a missing trait", () => {
      expect(errorsOf(withAgent(agent(["traits: [nope]", ...okSections])))).toEqual([
        "agents/alpha.yaml: traits[0]: no trait nope in targets/t/traits/ or traits/",
      ]);
    });

    it("reports an unknown param", () => {
      const files = withAgent(
        agent(["traits:", "  - { id: tone, params: { volume: 3 } }", ...okSections]),
        { "traits/tone.md": "---\nsection: role\n---\nCalm.\n" },
      );
      expect(errorsOf(files)).toEqual([
        "agents/alpha.yaml: traits[0].params.volume: trait tone has no param volume",
      ]);
    });

    it("reports a param of the wrong type, and a missing one", () => {
      const tone = "---\nsection: role\nparams: { voice: string, level: number }\n---\nCalm.\n";
      const files = withAgent(
        agent(["traits:", "  - { id: tone, params: { voice: 3 } }", ...okSections]),
        { "traits/tone.md": tone },
      );
      expect(errorsOf(files)).toEqual([
        "agents/alpha.yaml: traits[0].params.voice: must be a string",
        "agents/alpha.yaml: traits[0].params: trait tone needs param level",
      ]);
    });

    it("reports a param used in a trait but never declared", () => {
      const files = withAgent(agent(["traits: [tone]", ...okSections]), {
        "traits/tone.md": "---\nsection: role\n---\nBe {{params.mood}}.\n",
      });
      expect(errorsOf(files)).toEqual([
        "traits/tone.md: body: {{params.mood}} is not a param of trait tone",
      ]);
    });

    it("reports an undefined var, wherever it is", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "workflows/flow/steps/todo.md": "Ask {{vars.lead}}.\n",
          "traits/global/01-who.md": "{{vars.who}} owns it.\n",
          "squad.md": "{{vars.team}}\n",
          "targets/t/target.yaml":
            "id: t\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta]\nsquad: { name: S, leader: alpha }\n",
        }).toSorted(),
      ).toEqual(
        [
          "squad.md: body: {{vars.team}} is not defined by target t",
          "traits/global/01-who.md: body: {{vars.who}} is not defined by target t",
          "workflows/flow/steps/todo.md: body: {{vars.lead}} is not defined by target t",
        ].toSorted(),
      );
    });

    it("reports params and agent fields where they don't apply", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "workflows/flow/steps/todo.md": "{{agent.name}} {{params.x}} {{slot:role}} {{global}}\n",
        }),
      ).toEqual([
        "workflows/flow/steps/todo.md: body: {{agent.name}} only works in an agent's sections, traits and template",
        "workflows/flow/steps/todo.md: body: {{params.x}} only works in an opt-in trait",
        "workflows/flow/steps/todo.md: body: {{slot:role}} only works in a template",
        "workflows/flow/steps/todo.md: body: {{global}} only works in a template",
      ]);
    });

    it("reports unknown references and agent fields that aren't text", () => {
      expect(
        errorsOf(
          withAgent(
            agent([
              "sections:",
              "  role: '{{env.HOME}} {{agent.skills}} {{agent.nope}}'",
              "  handback: Done.",
            ]),
          ),
        ),
      ).toEqual([
        "agents/alpha.yaml: sections.role: {{env.HOME}} is not a known reference (vars, agent, params or workflows)",
        "agents/alpha.yaml: sections.role: {{agent.skills}} is not a text field of the agent",
        "agents/alpha.yaml: sections.role: {{agent.nope}} is not a text field of the agent",
      ]);
    });
  });

  describe("workflows", () => {
    it("reports an unknown workflow and an unknown column", () => {
      expect(
        errorsOf(
          withAgent(
            agent([
              "sections:",
              "  role: '{{workflows.other.entry}}'",
              "  handback: '{{workflows.flow.columns.nope}} {{workflows.flow.name}}'",
            ]),
          ),
        ),
      ).toEqual([
        "agents/alpha.yaml: sections.role: {{workflows.other.entry}} names a workflow target t doesn't use",
        "agents/alpha.yaml: sections.handback: {{workflows.flow.columns.nope}} names a column workflow flow doesn't have",
        "agents/alpha.yaml: sections.handback: {{workflows.flow.name}} must be workflows.<id>.entry or workflows.<id>.columns.<key>",
      ]);
    });

    it("reports a target that lists an unknown workflow or agent", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "targets/t/target.yaml":
            "id: t\nconnector: fake\nworkflows: [flow, other]\nagents: [alpha, beta, gamma, alpha]\n",
        }),
      ).toEqual([
        "targets/t/target.yaml: agents[2]: no agent gamma in agents/",
        "targets/t/target.yaml: agents[3]: lists alpha twice",
        "targets/t/target.yaml: workflows[1]: no workflow other in workflows/",
      ]);
    });

    it("reports a column with no way out, and duplicate keys", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "workflows/flow/workflow.yaml": [
            "id: flow",
            "entry: todo",
            "columns:",
            '  - { key: todo, handoff: "agent:alpha" }',
            '  - { key: review, handoff: "agent:beta", next: review }',
            "  - { key: done, handoff: none }",
            "  - { key: done, handoff: owner }",
          ].join("\n"),
        }),
      ).toEqual([
        "workflows/flow/workflow.yaml: columns[3].key: done is a duplicate key (columns[2] has it too)",
        "workflows/flow/workflow.yaml: columns[0]: column todo has no way out: it hands off to an agent, so it needs next",
        "workflows/flow/workflow.yaml: columns[1].next: moves the column to itself",
      ]);
    });

    it("reports bad moves, handlers, builders, entries and steps", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "workflows/flow/workflow.yaml": [
            "id: flow",
            "entry: start",
            "columns:",
            '  - { key: todo, handoff: "agent:ghost", next: nowhere, back: done }',
            "  - { key: wip, handoff: none, builders: [alpha, phantom] }",
            "  - { key: done, handoff: none }",
          ].join("\n"),
          "workflows/flow/steps/review.md": "Review.\n",
          "workflows/flow/steps/wip.md": "Build.\n",
        }),
      ).toEqual([
        "workflows/flow/workflow.yaml: entry: start is not a column key",
        "workflows/flow/workflow.yaml: columns[0].next: nowhere is not a column key",
        "workflows/flow/workflow.yaml: columns[0].handoff: no agent ghost in agents/",
        "workflows/flow/workflow.yaml: columns[1].builders[1]: no agent phantom in agents/",
        "workflows/flow/steps/review.md: (file): review.md is not a column of workflow flow",
        "workflows/flow/steps/wip.md: (file): column wip has no handoff, so it takes no step",
      ]);
    });

    it("needs a step for every agent column", () => {
      expect(errorsOf({ ...baseSetup(), "workflows/flow/steps/review.md": null })).toEqual([
        "workflows/flow/workflow.yaml: columns[1].handoff: hands off to an agent, so it needs steps/review.md",
      ]);
    });

    it("reports a column whose agent the target leaves out", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "targets/t/target.yaml": "id: t\nconnector: fake\nworkflows: [flow]\nagents: [alpha]\n",
        }),
      ).toEqual([
        "targets/t/target.yaml: workflows[0]: column review of workflow flow names agent beta, which agents doesn't list",
      ]);
    });
  });

  describe("templates and slots", () => {
    it("reports a trait slot missing from the agent's template", () => {
      const files = withAgent(agent(["traits: [aside]", ...okSections]), {
        "traits/aside.md": "---\nsection: aside\n---\nAn aside.\n",
      });
      expect(errorsOf(files)).toEqual([
        "agents/alpha.yaml: traits[0]: trait aside fills slot aside, which template default doesn't have",
      ]);
    });

    it("reports a section for a slot the template doesn't have", () => {
      expect(errorsOf(withAgent(agent([...okSections, "  extra: More."])))).toEqual([
        "agents/alpha.yaml: sections.extra: template default has no slot extra",
      ]);
    });

    it("reports an empty required slot", () => {
      expect(
        errorsOf(withAgent(agent(["sections:", "  role: You're Alpha.", "  handback: '  '"]))),
      ).toEqual([
        "agents/alpha.yaml: sections.handback: is empty, and template default requires it",
      ]);
    });

    it("reports template: missing, on the agent or on the target", () => {
      expect(errorsOf(withAgent(agent(["template: missing", ...okSections])))).toEqual([
        "agents/alpha.yaml: template: no template missing in targets/t/templates/, templates/ or the built-ins",
      ]);
      expect(
        errorsOf({
          ...baseSetup(),
          "targets/t/target.yaml":
            "id: t\nconnector: fake\ntemplate: gone\nworkflows: [flow]\nagents: [alpha, beta]\n",
        }),
      ).toEqual([
        "targets/t/target.yaml: template: no template gone in targets/t/templates/, templates/ or the built-ins",
      ]);
    });

    it("reports a declared slot the template never places, and an undeclared one", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "templates/default.md":
            "---\nslots:\n  role: { required: true }\n  handback: {}\n---\n{{slot:role}}\n\n{{slot:other}}\n",
        }),
      ).toEqual([
        "templates/default.md: slots.handback: is never placed: the body has no {{slot:handback}}",
        "templates/default.md: body: {{slot:other}} is not a slot of the template",
      ]);
    });
  });

  describe("schemas", () => {
    it("takes a 255-character description and refuses 256, counting code points", () => {
      expect(run(writeSetup(withDescription("é".repeat(255)))).errors).toEqual([]);
      expect(run(writeSetup(withDescription("😀".repeat(255)))).errors).toEqual([]);
      expect(errorsOf(withDescription("x".repeat(256)))).toEqual([
        "agents/alpha.yaml: description: must be at most 255 characters (it has 256)",
      ]);
    });

    it("reports an unknown squad.leader", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "targets/t/target.yaml":
            "id: t\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta]\nsquad: { name: S, leader: gamma }\n",
        }),
      ).toEqual(["targets/t/target.yaml: squad.leader: gamma is not one of the target's agents"]);
    });

    it("reports unknown and missing fields, and wrong types", () => {
      const errors = errorsOf(
        withAgent(
          [
            "id: alpha",
            "name: Alpha",
            "concurrency: 0",
            "model: { id: m, thinking: low, speed: 2 }",
            "colour: blue",
            ...okSections,
          ].join("\n"),
        ),
      );
      expect(errors).toEqual([
        "agents/alpha.yaml: description: is required",
        "agents/alpha.yaml: model.speed: is not a known field",
        "agents/alpha.yaml: concurrency: must be 1 or more",
        "agents/alpha.yaml: colour: is not a known field",
      ]);
    });

    it("reports an id that doesn't match its file, and invalid YAML", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "agents/beta.yaml":
            "id: gamma\nname: G\ndescription: d\nmodel: { id: m, thinking: t }\nconcurrency: 1\nsections: { role: r, handback: h }\n",
          "agents/delta.yaml": "id: [delta\n",
        }).map((line) => line.replace(/(\(yaml\): [^:]*).*/, "$1")),
      ).toEqual([
        "agents/beta.yaml: id: must match the file name (beta)",
        expect.stringMatching(/^agents\/delta\.yaml: \(yaml\): /),
      ]);
    });

    it("reports a file that isn't a mapping once", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "agents/beta.yaml": "- a\n- b\n",
          "agents/gamma.yaml": "text\n",
        }),
      ).toEqual([
        "agents/beta.yaml: (root): must be a mapping of fields",
        "agents/gamma.yaml: (root): must be a mapping of fields",
      ]);
    });

    it("treats an empty agent file as one with every field missing", () => {
      const errors = errorsOf({ ...baseSetup(), "agents/beta.yaml": "" });
      expect(errors).toContain("agents/beta.yaml: id: is required");
      // A target that lists the broken agent doesn't report it again.
      expect(errors.some((line) => line.startsWith("targets/"))).toBe(false);
    });

    it("refuses frontmatter on a global trait, and an opt-in trait with none", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "traits/global/01-a.md": "---\nsection: role\n---\nText.\n",
          "traits/plain.md": "No frontmatter.\n",
        }),
      ).toEqual([
        "traits/plain.md: section: is required: an opt-in trait names the slot it fills",
        "traits/global/01-a.md: (frontmatter): a global trait has no frontmatter: no section and no params",
      ]);
    });

    it("reports a missing setup directory and an unknown target", () => {
      const dir = join(writeSetup({}), "nowhere");
      expect(validate(dir)).toEqual([`${dir}: (dir): is not a setup directory: it doesn't exist`]);
      expect(run(writeSetup(baseSetup()), "other").errors).toEqual([
        "targets: other: is not a target of this setup",
      ]);
    });
  });

  describe("overrides", () => {
    it("reports overrides of things that don't exist", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "targets/t/target.yaml": [
            "id: t",
            "connector: fake",
            "workflows: [flow]",
            "agents: [alpha, beta]",
            "overrides:",
            "  workflows.flow.steps.nope: { replace: o.md }",
            "  workflows.flow.steps.done: { replace: o.md }",
            "  workflows.flow.steps.blocked: { append: o.md }",
            "  workflows.gone.steps.todo: { replace: o.md }",
            "  traits.global.99-none: { replace: o.md }",
            "  traits.none: { replace: o.md }",
            "  agents.alpha: { replace: o.md }",
            "  traits.global.01-a: { replace: missing.md }",
            "  traits.global.02-b: { replace: ../../../outside.md }",
          ].join("\n"),
          "targets/t/o.md": "Text.\n",
          "outside.md": "Out.\n",
        }),
      ).toEqual([
        "targets/t/target.yaml: overrides.agents.alpha: must be workflows.<id>.steps.<column>, traits.<id> or traits.global.<id>",
        "targets/t/target.yaml: overrides.traits.global.01-a.replace: missing.md doesn't exist",
        "targets/t/target.yaml: overrides.traits.global.02-b.replace: ../../../outside.md is outside the setup",
        "targets/t/target.yaml: overrides.workflows.flow.steps.nope: names column nope, which workflow flow doesn't have",
        "targets/t/target.yaml: overrides.workflows.flow.steps.done: column done has no handoff, so it has no step",
        "targets/t/target.yaml: overrides.workflows.flow.steps.blocked: appends to steps/blocked.md of workflow flow, which doesn't exist",
        "targets/t/target.yaml: overrides.workflows.gone.steps.todo: names workflow gone, which workflows doesn't list",
        "targets/t/target.yaml: overrides.traits.global.99-none: names global trait 99-none, which neither global folder has",
        "targets/t/target.yaml: overrides.traits.none: names trait none, which no traits folder has",
      ]);
    });

    it("reports an override that is a folder, not a file", () => {
      const errors = errorsOf({
        ...baseSetup(),
        "targets/t/target.yaml":
          "id: t\nconnector: fake\nworkflows: [flow]\nagents: [alpha, beta]\noverrides:\n  workflows.flow.steps.todo: { replace: notes }\n",
        "targets/t/notes/a.md": "A.\n",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /^targets\/t\/target\.yaml: overrides\.workflows\.flow\.steps\.todo\.replace: notes can't be read: /,
      );
    });

    it("refuses a target global trait with a shared trait's name", () => {
      expect(
        errorsOf({
          ...baseSetup(),
          "traits/global/01-a.md": "Shared.\n",
          "targets/t/traits/global/01-a.md": "Own.\n",
        }),
      ).toEqual([
        "targets/t/traits/global/01-a.md: (file): has the name of the shared traits/global/01-a.md: change that one with an override instead",
      ]);
    });
  });
});
