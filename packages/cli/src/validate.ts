// Checks a whole setup: its files, its workflows' graphs and every reference in every target.

import { basename } from "node:path";

import type { Diagnostics } from "./diagnostics.ts";
import type { LoadedWorkflow, Setup } from "./loader.ts";
import { checkTemplate, renderTarget } from "./render.ts";

export interface ValidateOptions {
  /** Check only this target's references. The default checks every target. */
  target?: string;
}

/** Checks `setup`, adding every error to `diagnostics`. */
export const validateSetup = (
  setup: Setup,
  diagnostics: Diagnostics,
  options: ValidateOptions = {},
): void => {
  for (const template of setup.templates.values()) checkTemplate(template, diagnostics);
  for (const target of setup.targets.values()) {
    for (const template of target.templates.values()) checkTemplate(template, diagnostics);
  }
  for (const workflow of setup.workflows.values()) checkWorkflow(workflow, setup, diagnostics);
  const slugs = options.target === undefined ? [...setup.targets.keys()] : [options.target];
  for (const slug of slugs) renderTarget(setup, slug, diagnostics);
};

/** A workflow's own graph: keys, moves, handlers and steps. */
export const checkWorkflow = (
  { file, workflow, steps }: LoadedWorkflow,
  setup: Setup,
  diagnostics: Diagnostics,
): void => {
  const first = new Map<string, number>();
  workflow.columns.forEach((column, index) => {
    const earlier = first.get(column.key);
    if (earlier === undefined) first.set(column.key, index);
    else {
      diagnostics.add(
        file,
        `columns[${index}].key`,
        `${column.key} is a duplicate key (columns[${earlier}] has it too)`,
      );
    }
  });
  if (!first.has(workflow.entry)) {
    diagnostics.add(file, "entry", `${workflow.entry} is not a column key`);
  }
  const knownAgent = (id: string) => setup.agents.has(id) || setup.broken.has(`agent:${id}`);
  workflow.columns.forEach((column, index) => {
    const at = `columns[${index}]`;
    for (const move of ["next", "back"] as const) {
      const key = column[move];
      if (key === undefined) continue;
      if (key === column.key) diagnostics.add(file, `${at}.${move}`, "moves the column to itself");
      else if (!first.has(key))
        diagnostics.add(file, `${at}.${move}`, `${key} is not a column key`);
    }
    const handler = column.handoff.startsWith("agent:") ? column.handoff.slice(6) : undefined;
    if (handler !== undefined) {
      if (!knownAgent(handler))
        diagnostics.add(file, `${at}.handoff`, `no agent ${handler} in agents/`);
      if (column.next === undefined) {
        diagnostics.add(
          file,
          at,
          `column ${column.key} has no way out: it hands off to an agent, so it needs next`,
        );
      }
      if (!steps.has(column.key)) {
        diagnostics.add(
          file,
          `${at}.handoff`,
          `hands off to an agent, so it needs steps/${column.key}.md`,
        );
      }
    }
    column.builders?.forEach((builder, builderIndex) => {
      if (!knownAgent(builder)) {
        diagnostics.add(file, `${at}.builders[${builderIndex}]`, `no agent ${builder} in agents/`);
      }
    });
  });
  for (const [key, step] of steps) {
    const column = workflow.columns.find((candidate) => candidate.key === key);
    if (!column) {
      diagnostics.add(
        step.file,
        "(file)",
        `${basename(step.file)} is not a column of workflow ${workflow.id}`,
      );
    } else if (column.handoff === "none") {
      diagnostics.add(step.file, "(file)", `column ${key} has no handoff, so it takes no step`);
    }
  }
};
