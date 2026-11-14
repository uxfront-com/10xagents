// Renders one target of a setup: every agent's prompt, its workflows, the shared context and the squad.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ColumnNames } from "./contract.ts";
import { BUILT_IN_TEMPLATES } from "./default-template.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { LoadedAgent, Setup, SkillFolder, SourceText, Template, Trait } from "./loader.ts";
import type { Scalar, Target, Workflow } from "./schema.ts";
import { interpolate, joinBlocks, normalize } from "./text.ts";
import type { Scope } from "./text.ts";

export interface RenderOptions {
  /** Global traits go into the shared context once, and `{{global}}` renders nothing. */
  sharedContext?: boolean;
  /** The connector's platform name for each column. The default is the column's `name`, or its key. */
  columnNames?: (workflows: readonly Workflow[]) => ColumnNames;
}

/** A target, with `workspace` set: the target's id unless `target.yaml` gives one. */
export type RenderedTarget = Target & { workspace: string };

export interface RenderedAgent {
  id: string;
  name: string;
  description: string;
  /** The template the prompt was rendered with. */
  template: string;
  model: { id: string; thinking: string };
  concurrency: number;
  skills: string[];
  /** The agent's role in the squad: `squad.role`, or `member`. */
  role: string;
  /** The rendered prompt, with no trailing newline. */
  instructions: string;
}

export interface RenderedColumn {
  key: string;
  /** The column's platform name. */
  name: string;
  category?: string;
  handoff: string;
  next?: string;
  back?: string;
  builders?: string[];
  /** The rendered step, for a column that has one. */
  instructions?: string;
}

export interface RenderedWorkflow {
  id: string;
  entry: string;
  columns: RenderedColumn[];
}

export interface RenderedSquad {
  name: string;
  leader: string;
  instructions: string;
  /** Each member's role, by agent id. */
  members: Record<string, string>;
}

/** A skill the target gets: its name, and the folder that holds its files. */
export interface RenderedSkill {
  name: string;
  dir: string;
}

export interface RenderedSetup {
  target: RenderedTarget;
  agents: RenderedAgent[];
  workflows: RenderedWorkflow[];
  /**
   * The setup's `skills/` and the target's own, sorted by name. A target's skill replaces the
   * setup's skill with the same name.
   */
  skills: RenderedSkill[];
  /** The global traits, when the connector has a shared context. Empty otherwise. */
  sharedContext: string;
  squad?: RenderedSquad;
}

interface Piece {
  file: string;
  field: string;
  text: string;
}

interface OverrideEntry {
  mode: "replace" | "append";
  source: SourceText;
}

const STEP_KEY = /^workflows\.([^.]+)\.steps\.([^.]+)$/;
const GLOBAL_KEY = /^traits\.global\.([^.]+)$/;
const TRAIT_KEY = /^traits\.([^.]+)$/;
const GLOBAL_PLACEHOLDER = /\{\{\s*global\s*\}\}/;
const SLOT_PLACEHOLDER = /\{\{\s*slot:([^{}\s]*)\s*\}\}/g;

/** Drops a block's blank first lines and trailing whitespace, keeping its indentation. */
const trimBlock = (block: string): string => block.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

/** The column names a connector without `columnNames` gets: each column's `name`, or its key. */
export const defaultColumnNames = (workflows: readonly Workflow[]): ColumnNames =>
  Object.fromEntries(
    workflows.map((workflow) => [
      workflow.id,
      Object.fromEntries(workflow.columns.map((column) => [column.key, column.name ?? column.key])),
    ]),
  );

/**
 * Renders the target `slug` of `setup`. Every error goes to `diagnostics`. The result is
 * `undefined` only when the target doesn't exist. Check `diagnostics` before using it.
 */
export const renderTarget = (
  setup: Setup,
  slug: string,
  diagnostics: Diagnostics,
  options: RenderOptions = {},
): RenderedSetup | undefined => {
  const loaded = setup.targets.get(slug);
  if (!loaded) {
    if (!setup.broken.has(`target:${slug}`)) {
      diagnostics.add(resolve(setup.dir, "targets"), slug, "is not a target of this setup");
    }
    return undefined;
  }
  const { target } = loaded;
  const report = (file: string, field: string) => (message: string) =>
    diagnostics.add(file, field, message);
  const atTarget = (field: string, message: string) => diagnostics.add(loaded.file, field, message);

  /** A path from `target.yaml`, inside the setup. Reports it when it isn't there. */
  const targetFile = (path: string, field: string): SourceText | undefined => {
    const file = resolve(loaded.dir, path);
    const inside = relative(setup.dir, file);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      atTarget(field, `${path} is outside the setup`);
      return undefined;
    }
    if (!existsSync(file)) {
      atTarget(field, `${path} doesn't exist`);
      return undefined;
    }
    try {
      return { file, text: normalize(readFileSync(file, "utf8")) };
    } catch (error) {
      atTarget(
        field,
        `${path} can't be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  // Overrides, by key. Their targets are checked once everything else is known.
  const overrides = new Map<string, OverrideEntry>();
  for (const [key, value] of Object.entries(target.overrides)) {
    const mode = "replace" in value ? "replace" : "append";
    const path = "replace" in value ? value.replace : value.append;
    if (!STEP_KEY.test(key) && !GLOBAL_KEY.test(key) && !TRAIT_KEY.test(key)) {
      atTarget(
        `overrides.${key}`,
        "must be workflows.<id>.steps.<column>, traits.<id> or traits.global.<id>",
      );
      continue;
    }
    const source = targetFile(path, `overrides.${key}.${mode}`);
    if (source) overrides.set(key, { mode, source });
  }
  const overridden = (key: string, base: Piece | undefined): Piece[] => {
    const entry = overrides.get(key);
    if (!entry) return base ? [base] : [];
    const piece = { file: entry.source.file, field: "body", text: entry.source.text };
    return entry.mode === "replace" || !base ? [piece] : [base, piece];
  };
  const renderPieces = (pieces: readonly Piece[], scope: Scope): string =>
    joinBlocks(
      pieces.map((piece) => interpolate(piece.text, scope, report(piece.file, piece.field))),
    );

  // Agents.
  const agents: LoadedAgent[] = [];
  target.agents.forEach((id, index) => {
    if (target.agents.indexOf(id) !== index) {
      atTarget(`agents[${index}]`, `lists ${id} twice`);
      return;
    }
    const agent = setup.agents.get(id);
    if (agent) agents.push(agent);
    else if (!setup.broken.has(`agent:${id}`)) {
      atTarget(`agents[${index}]`, `no agent ${id} in agents/`);
    }
  });

  // Workflows, and the names their references render.
  const workflows: Workflow[] = [];
  const workflowFiles = new Map<string, string>();
  target.workflows.forEach((id, index) => {
    if (target.workflows.indexOf(id) !== index) {
      atTarget(`workflows[${index}]`, `lists ${id} twice`);
      return;
    }
    const loadedWorkflow = setup.workflows.get(id);
    if (!loadedWorkflow) {
      if (!setup.broken.has(`workflow:${id}`)) {
        atTarget(`workflows[${index}]`, `no workflow ${id} in workflows/`);
      }
      return;
    }
    workflows.push(loadedWorkflow.workflow);
    workflowFiles.set(id, loadedWorkflow.file);
    for (const column of loadedWorkflow.workflow.columns) {
      const handler = column.handoff.startsWith("agent:") ? column.handoff.slice(6) : undefined;
      for (const agent of [...(handler ? [handler] : []), ...(column.builders ?? [])]) {
        if (setup.agents.has(agent) && !target.agents.includes(agent)) {
          atTarget(
            `workflows[${index}]`,
            `column ${column.key} of workflow ${id} names agent ${agent}, which agents doesn't list`,
          );
        }
      }
    }
  });
  const names = (options.columnNames ?? defaultColumnNames)(workflows);
  const workflowScope: Scope["workflows"] = new Map(
    workflows.map((workflow) => {
      const own = names[workflow.id] ?? {};
      const nameOf = (key: string) =>
        own[key] ?? workflow.columns.find((column) => column.key === key)?.name ?? key;
      return [
        workflow.id,
        {
          entry: nameOf(workflow.entry),
          columns: new Map(workflow.columns.map((column) => [column.key, nameOf(column.key)])),
        },
      ];
    }),
  );
  const scope: Scope = { target: slug, vars: target.vars, workflows: workflowScope };

  // Global traits: the setup's, then the target's own, each in file-name order.
  const sharedIds = new Set(setup.globals.map((trait) => trait.id));
  const globals = [
    ...setup.globals,
    ...loaded.globals.filter((trait) => {
      if (!sharedIds.has(trait.id)) return true;
      diagnostics.add(
        trait.file,
        "(file)",
        `has the name of the shared traits/global/${trait.id}.md: change that one with an override instead`,
      );
      return false;
    }),
  ];
  const globalText = joinBlocks(
    globals.map((trait) =>
      renderPieces(
        overridden(`traits.global.${trait.id}`, {
          file: trait.file,
          field: "body",
          text: trait.body,
        }),
        scope,
      ),
    ),
  );
  const sharedContext = options.sharedContext ? globalText : "";
  const inlineGlobals = options.sharedContext ? "" : globalText;

  // Templates and traits resolve in the target's folder first, then the setup's.
  const findTemplate = (id: string): Template | undefined =>
    loaded.templates.get(id) ?? setup.templates.get(id) ?? BUILT_IN_TEMPLATES.get(id);
  const findTrait = (id: string): Trait | undefined =>
    loaded.traits.get(id) ?? setup.traits.get(id);
  const missingTemplate = (id: string) =>
    `no template ${id} in targets/${slug}/templates/, templates/ or the built-ins`;

  const renderAgent = ({ file, agent }: LoadedAgent): RenderedAgent | undefined => {
    let template: Template | undefined;
    if (agent.template !== undefined) {
      template = findTemplate(agent.template);
      if (!template && !setup.broken.has(`template:${agent.template}`)) {
        diagnostics.add(file, "template", missingTemplate(agent.template));
      }
    } else if (target.template !== undefined) {
      template = findTemplate(target.template);
      if (!template && !setup.broken.has(`template:${target.template}`)) {
        atTarget("template", missingTemplate(target.template));
      }
    } else template = findTemplate("default");
    if (!template) return undefined;
    checkTemplate(template, diagnostics);

    const role = agent.squad?.role ?? "member";
    const agentScope: Scope = {
      ...scope,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        template: template.id,
        model: agent.model,
        concurrency: agent.concurrency,
        squad: { role },
      },
    };

    const content = new Map<string, string[]>();
    const fill = (slot: string, text: string) =>
      content.set(slot, [...(content.get(slot) ?? []), text]);
    for (const [slot, text] of Object.entries(agent.sections)) {
      if (!template.slots.has(slot)) {
        diagnostics.add(file, `sections.${slot}`, `template ${template.id} has no slot ${slot}`);
        continue;
      }
      fill(slot, interpolate(text, agentScope, report(file, `sections.${slot}`)));
    }
    agent.traits.forEach((ref, index) => {
      const id = typeof ref === "string" ? ref : ref.id;
      const given = typeof ref === "string" ? {} : ref.params;
      const trait = findTrait(id);
      if (!trait) {
        if (!setup.broken.has(`trait:${id}`)) {
          diagnostics.add(
            file,
            `traits[${index}]`,
            `no trait ${id} in targets/${slug}/traits/ or traits/`,
          );
        }
        return;
      }
      if (!template.slots.has(trait.section)) {
        diagnostics.add(
          file,
          `traits[${index}]`,
          `trait ${id} fills slot ${trait.section}, which template ${template.id} doesn't have`,
        );
        return;
      }
      const values: Record<string, Scalar> = {};
      for (const [param, value] of Object.entries(given)) {
        const decl = trait.params[param];
        if (!decl) {
          diagnostics.add(
            file,
            `traits[${index}].params.${param}`,
            `trait ${id} has no param ${param}`,
          );
        } else if (typeof value !== decl.type) {
          diagnostics.add(file, `traits[${index}].params.${param}`, `must be a ${decl.type}`);
        } else values[param] = value;
      }
      for (const [param, decl] of Object.entries(trait.params)) {
        if (Object.hasOwn(given, param)) continue;
        if (decl.default === undefined) {
          diagnostics.add(file, `traits[${index}].params`, `trait ${id} needs param ${param}`);
          // A stand-in, so the trait's own text doesn't report the same param again.
          values[param] = "";
        } else values[param] = decl.default;
      }
      const pieces = overridden(`traits.${id}`, {
        file: trait.file,
        field: "body",
        text: trait.body,
      });
      fill(trait.section, renderPieces(pieces, { ...agentScope, params: { trait: id, values } }));
    });

    const slotText = new Map<string, string>();
    for (const [slot, def] of template.slots) {
      const text = joinBlocks(content.get(slot) ?? []);
      if (def.required && !text) {
        diagnostics.add(
          file,
          `sections.${slot}`,
          `is empty, and template ${template.id} requires it`,
        );
      }
      slotText.set(slot, text && def.heading ? `## ${def.heading}\n\n${text}` : text);
    }
    const body = template.body
      .split(/\n[ \t]*\n/)
      .map((block) =>
        trimBlock(
          interpolate(
            block,
            { ...agentScope, slot: (id) => slotText.get(id), global: () => inlineGlobals },
            report(template.file, "body"),
          ),
        ),
      )
      .filter(Boolean)
      .join("\n\n");
    const instructions = GLOBAL_PLACEHOLDER.test(template.body)
      ? body
      : joinBlocks([body, inlineGlobals]);

    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      template: template.id,
      model: { id: agent.model.id, thinking: agent.model.thinking },
      concurrency: agent.concurrency,
      skills: [...agent.skills],
      role,
      instructions,
    };
  };

  const renderedAgents = agents.flatMap((agent) => renderAgent(agent) ?? []);

  // Workflow steps, with the target's overrides.
  const renderedWorkflows = workflows.map((workflow): RenderedWorkflow => {
    const loadedWorkflow = setup.workflows.get(workflow.id);
    const own = workflowScope.get(workflow.id);
    return {
      id: workflow.id,
      entry: workflow.entry,
      columns: workflow.columns.map((column): RenderedColumn => {
        const step = loadedWorkflow?.steps.get(column.key);
        const pieces = overridden(
          `workflows.${workflow.id}.steps.${column.key}`,
          step ? { file: step.file, field: "body", text: step.text } : undefined,
        );
        const instructions = pieces.length > 0 ? renderPieces(pieces, scope) : undefined;
        return {
          key: column.key,
          name: own?.columns.get(column.key) ?? column.key,
          ...(column.category === undefined ? {} : { category: column.category }),
          handoff: column.handoff,
          ...(column.next === undefined ? {} : { next: column.next }),
          ...(column.back === undefined ? {} : { back: column.back }),
          ...(column.builders === undefined ? {} : { builders: [...column.builders] }),
          ...(instructions === undefined ? {} : { instructions }),
        };
      }),
    };
  });

  // Every override must change something that exists.
  for (const [key, { mode }] of overrides) {
    const field = `overrides.${key}`;
    const step = STEP_KEY.exec(key);
    if (step) {
      const [, id = "", columnKey = ""] = step;
      const workflow = workflows.find((candidate) => candidate.id === id);
      const column = workflow?.columns.find((candidate) => candidate.key === columnKey);
      if (!workflow) atTarget(field, `names workflow ${id}, which workflows doesn't list`);
      else if (!column)
        atTarget(field, `names column ${columnKey}, which workflow ${id} doesn't have`);
      else if (column.handoff === "none") {
        atTarget(field, `column ${columnKey} has no handoff, so it has no step`);
      } else if (mode === "append" && !setup.workflows.get(id)?.steps.has(columnKey)) {
        atTarget(field, `appends to steps/${columnKey}.md of workflow ${id}, which doesn't exist`);
      }
      continue;
    }
    const global = GLOBAL_KEY.exec(key);
    if (global) {
      if (!globals.some((trait) => trait.id === global[1])) {
        atTarget(field, `names global trait ${global[1]}, which neither global folder has`);
      }
      continue;
    }
    const id = TRAIT_KEY.exec(key)?.[1] ?? "";
    if (!findTrait(id)) atTarget(field, `names trait ${id}, which no traits folder has`);
  }

  // The squad.
  let squad: RenderedSquad | undefined;
  if (target.squad) {
    const { name, leader } = target.squad;
    if (!target.agents.includes(leader)) {
      atTarget("squad.leader", `${leader} is not one of the target's agents`);
    }
    const source =
      target.squad.instructions === undefined
        ? (loaded.squad ?? setup.squad)
        : targetFile(target.squad.instructions, "squad.instructions");
    squad = {
      name,
      leader,
      instructions: source
        ? renderPieces([{ file: source.file, field: "body", text: source.text }], scope)
        : "",
      members: Object.fromEntries(renderedAgents.map((agent) => [agent.id, agent.role])),
    };
  }

  // Skills: the target's own first, so it replaces the setup's skill with its name.
  const skills = new Map<string, SkillFolder>([...setup.skills, ...loaded.skills]);

  return {
    target: { ...target, workspace: target.workspace ?? target.id },
    agents: renderedAgents,
    workflows: renderedWorkflows,
    skills: [...skills.values()]
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((skill) => ({ name: skill.name, dir: skill.dir })),
    sharedContext,
    ...(squad ? { squad } : {}),
  };
};

/** A template must place every slot it declares. */
export const checkTemplate = (template: Template, diagnostics: Diagnostics): void => {
  const placed = new Set([...template.body.matchAll(SLOT_PLACEHOLDER)].map((match) => match[1]));
  for (const slot of template.slots.keys()) {
    if (!placed.has(slot)) {
      diagnostics.add(
        template.file,
        `slots.${slot}`,
        `is never placed: the body has no {{slot:${slot}}}`,
      );
    }
  }
};
