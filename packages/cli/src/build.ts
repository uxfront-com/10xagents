// Turns a rendered target into files: the same input always gives the same bytes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stringify } from "yaml";

import type { RenderedSetup } from "./render.ts";

/** JSON with every object's keys sorted, two-space indented, ending in a newline. */
export const stableJson = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]: [string, unknown]) => [key, sortKeys(item)]),
    );
  }
  return value;
};

/** YAML frontmatter with sorted keys, then the text as it is: no trailing newline. */
const withFrontmatter = (data: Record<string, unknown>, text: string): string =>
  `---\n${stringify(sortKeys(data), { lineWidth: 0 })}---\n\n${text}`;

/**
 * The files `build` writes, by path relative to the output directory:
 *
 * - `agents/<id>.md`: the agent's settings as frontmatter, then its prompt.
 * - `workflows/<id>.json`: the columns, with each step's rendered text.
 * - `shared-context.md`: the global traits, when the connector has a shared context.
 * - `squad.md`: the squad's name, leader and member roles as frontmatter, then its instructions.
 */
export const buildFiles = (rendered: RenderedSetup): Map<string, string> => {
  const files = new Map<string, string>();
  for (const agent of rendered.agents) {
    const { instructions, role: _role, ...settings } = agent;
    files.set(`agents/${agent.id}.md`, withFrontmatter(settings, instructions));
  }
  for (const workflow of rendered.workflows) {
    files.set(`workflows/${workflow.id}.json`, stableJson(workflow));
  }
  if (rendered.sharedContext) files.set("shared-context.md", rendered.sharedContext);
  if (rendered.squad) {
    const { instructions, ...squad } = rendered.squad;
    files.set("squad.md", withFrontmatter(squad, instructions));
  }
  return files;
};

/** Writes `files` under `out`. It never deletes anything there. */
export const writeFiles = (out: string, files: ReadonlyMap<string, string>): void => {
  for (const [path, content] of files) {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
};
