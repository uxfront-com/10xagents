// Small setups written to temporary directories, and the calls the tests repeat.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach } from "vitest";

import { Diagnostics, formatDiagnostic } from "../src/diagnostics.ts";
import { loadSetup } from "../src/loader.ts";
import { renderTarget } from "../src/render.ts";
import type { RenderedSetup, RenderOptions } from "../src/render.ts";
import { validateSetup } from "../src/validate.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test. */
export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "10xagents-"));
  made.push(dir);
  return dir;
};

export type Files = Record<string, string | null>;

/** Writes `files` (path → text) to a fresh directory. A `null` leaves that file out. */
export const writeSetup = (files: Files): string => {
  const dir = tempDir();
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
};

const agentYaml = (id: string, name: string, extra = ""): string =>
  [
    `id: ${id}`,
    `name: ${name}`,
    "description: An agent for tests.",
    "model: { id: test-model, thinking: low }",
    "concurrency: 1",
    extra,
    "sections:",
    `  role: You're the ${name}.`,
    "  handback: The result.",
    "",
  ].join("\n");

/** A small valid setup with one target, `t`. Spread it and change what a test needs. */
export const baseSetup = (): Files => ({
  "agents/alpha.yaml": agentYaml("alpha", "Alpha"),
  "agents/beta.yaml": agentYaml("beta", "Beta", "squad: { role: Reviews the work. }"),
  "workflows/flow/workflow.yaml": [
    "id: flow",
    "entry: todo",
    "columns:",
    '  - { key: todo, name: To do, handoff: "agent:alpha", next: review }',
    '  - { key: review, name: Review, handoff: "agent:beta", next: done, back: todo }',
    "  - { key: blocked, name: Blocked, handoff: owner }",
    "  - { key: done, name: Done, handoff: none }",
    "",
  ].join("\n"),
  "workflows/flow/steps/todo.md": "Start the work.\n",
  "workflows/flow/steps/review.md": "Review the work.\n",
  "targets/t/target.yaml": [
    "id: t",
    "connector: fake",
    "workflows: [flow]",
    "agents: [alpha, beta]",
    "vars: { owner: Sam }",
    "",
  ].join("\n"),
});

export interface Run {
  errors: string[];
  rendered?: RenderedSetup;
}

/** Loads and validates the setup in `dir`, then renders target `slug` with `options`. */
export const run = (dir: string, slug = "t", options: RenderOptions = {}): Run => {
  const diagnostics = new Diagnostics();
  const setup = loadSetup(dir, diagnostics);
  validateSetup(setup, diagnostics, { target: slug });
  const errors = diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, dir));
  if (errors.length > 0) return { errors };
  const rendered = renderTarget(setup, slug, diagnostics, options);
  return {
    errors: diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, dir)),
    ...(rendered ? { rendered } : {}),
  };
};

/** Renders `files` and returns the errors, or throws when there are none. */
export const errorsOf = (files: Files): string[] => {
  const { errors } = run(writeSetup(files));
  if (errors.length === 0) throw new Error("expected errors, got none");
  return errors;
};

/** Renders `files`, and throws on any error. */
export const renderOk = (files: Files, options: RenderOptions = {}): RenderedSetup => {
  const { errors, rendered } = run(writeSetup(files), "t", options);
  if (errors.length > 0 || !rendered) throw new Error(`expected no errors:\n${errors.join("\n")}`);
  return rendered;
};

/** One agent's rendered prompt. */
export const promptOf = (rendered: RenderedSetup, id: string): string => {
  const agent = rendered.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`no agent ${id}`);
  return agent.instructions;
};
