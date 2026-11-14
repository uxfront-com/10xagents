// Reads a setup from a local directory. Remote sources and `extends` come later.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { parse } from "yaml";

import type { Diagnostics } from "./diagnostics.ts";
import type { Agent, Target, TemplateMeta, Workflow } from "./schema.ts";
import {
  AgentSchema,
  check,
  TargetSchema,
  TemplateSchema,
  TraitSchema,
  WorkflowSchema,
} from "./schema.ts";
import type { Scalar } from "./schema.ts";
import { normalize, splitFrontmatter } from "./text.ts";

/** A file's text, with its absolute path. */
export interface SourceText {
  file: string;
  text: string;
}

export interface Template {
  id: string;
  file: string;
  /** The declared slots, in the frontmatter's order. */
  slots: Map<string, { heading?: string; required: boolean }>;
  body: string;
}

export interface Param {
  type: "string" | "number" | "boolean";
  default?: Scalar;
}

export interface Trait {
  id: string;
  file: string;
  section: string;
  params: Record<string, Param>;
  body: string;
}

export interface GlobalTrait {
  /** The file name without `.md`. Its order decides the trait's place. */
  id: string;
  file: string;
  body: string;
}

/** A skill: a folder under `skills/`, named after the skill. A connector reads its files. */
export interface SkillFolder {
  name: string;
  /** The folder's absolute path. */
  dir: string;
}

export interface LoadedAgent {
  file: string;
  agent: Agent;
}

export interface LoadedWorkflow {
  file: string;
  workflow: Workflow;
  /** `steps/<key>.md`, by column key. */
  steps: Map<string, SourceText>;
}

export interface LoadedTarget {
  file: string;
  dir: string;
  target: Target;
  templates: Map<string, Template>;
  traits: Map<string, Trait>;
  globals: GlobalTrait[];
  /** `targets/<slug>/skills/`, by name. */
  skills: Map<string, SkillFolder>;
  squad?: SourceText;
}

export interface Setup {
  dir: string;
  templates: Map<string, Template>;
  traits: Map<string, Trait>;
  globals: GlobalTrait[];
  agents: Map<string, LoadedAgent>;
  workflows: Map<string, LoadedWorkflow>;
  targets: Map<string, LoadedTarget>;
  /** `skills/`, by name: the skills every target gets. */
  skills: Map<string, SkillFolder>;
  squad?: SourceText;
  /**
   * Files that exist but didn't load, as `<kind>:<path>`. A reference to one isn't reported
   * again as unknown.
   */
  broken: Set<string>;
}

const readText = (file: string): string => normalize(readFileSync(file, "utf8"));

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** A directory's entries, sorted by name, without dotfiles. */
const entries = (dir: string): string[] =>
  isDir(dir)
    ? readdirSync(dir)
        .filter((name) => !name.startsWith("."))
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];

const filesWith = (dir: string, extensions: readonly string[]): string[] =>
  entries(dir).filter((name) => extensions.includes(extname(name)) && !isDir(join(dir, name)));

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** Parses a YAML file, or reports it and returns `undefined`. */
const readYaml = (file: string, diagnostics: Diagnostics): unknown => {
  try {
    return parse(readText(file)) ?? {};
  } catch (error) {
    diagnostics.add(file, "(yaml)", message(error));
    return undefined;
  }
};

/** Parses a Markdown file's frontmatter, or reports it and returns `undefined`. */
const readMarkdown = (
  file: string,
  diagnostics: Diagnostics,
): { data: unknown; body: string } | undefined => {
  try {
    return splitFrontmatter(readText(file));
  } catch (error) {
    diagnostics.add(file, "(frontmatter)", message(error));
    return undefined;
  }
};

const loadTemplates = (dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
  const templates = new Map<string, Template>();
  for (const name of filesWith(dir, [".md"])) {
    const file = join(dir, name);
    const id = basename(name, ".md");
    const markdown = readMarkdown(file, diagnostics);
    const parsed = markdown && check(TemplateSchema, markdown.data ?? {});
    for (const issue of parsed?.issues ?? []) diagnostics.add(file, issue.field, issue.message);
    if (!markdown || !parsed?.output) {
      broken.add(`template:${id}`);
      continue;
    }
    templates.set(id, toTemplate(id, file, parsed.output, markdown.body));
  }
  return templates;
};

export const toTemplate = (
  id: string,
  file: string,
  meta: TemplateMeta,
  body: string,
): Template => ({
  id,
  file,
  slots: new Map(
    Object.entries(meta.slots).map(([slot, def]) => [
      slot,
      def.heading === undefined
        ? { required: def.required }
        : { heading: def.heading, required: def.required },
    ]),
  ),
  body,
});

const loadTraits = (dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
  const traits = new Map<string, Trait>();
  for (const name of filesWith(dir, [".md"])) {
    const file = join(dir, name);
    const id = basename(name, ".md");
    const markdown = readMarkdown(file, diagnostics);
    if (markdown && markdown.data === undefined) {
      diagnostics.add(file, "section", "is required: an opt-in trait names the slot it fills");
    }
    const parsed = markdown?.data === undefined ? undefined : check(TraitSchema, markdown.data);
    for (const issue of parsed?.issues ?? []) diagnostics.add(file, issue.field, issue.message);
    if (!markdown || !parsed?.output) {
      broken.add(`trait:${id}`);
      continue;
    }
    const params = Object.fromEntries(
      Object.entries(parsed.output.params).map(([param, decl]): [string, Param] => [
        param,
        typeof decl === "string"
          ? { type: decl }
          : decl.default === undefined
            ? { type: decl.type }
            : { type: decl.type, default: decl.default },
      ]),
    );
    for (const [param, decl] of Object.entries(params)) {
      if (decl.default !== undefined && typeof decl.default !== decl.type) {
        diagnostics.add(file, `params.${param}.default`, `must be a ${decl.type}`);
      }
    }
    traits.set(id, { id, file, section: parsed.output.section, params, body: markdown.body });
  }
  return traits;
};

const loadGlobals = (dir: string, diagnostics: Diagnostics): GlobalTrait[] =>
  filesWith(dir, [".md"]).flatMap((name) => {
    const file = join(dir, name);
    const markdown = readMarkdown(file, diagnostics);
    if (!markdown) return [];
    if (markdown.data !== undefined) {
      diagnostics.add(
        file,
        "(frontmatter)",
        "a global trait has no frontmatter: no section and no params",
      );
    }
    return [{ id: basename(name, ".md"), file, body: markdown.body }];
  });

/** Every folder in `dir` is a skill, named after the folder. */
const loadSkills = (dir: string): Map<string, SkillFolder> =>
  new Map(
    entries(dir)
      .filter((name) => isDir(join(dir, name)))
      .map((name) => [name, { name, dir: join(dir, name) }]),
  );

const loadAgents = (dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
  const agents = new Map<string, LoadedAgent>();
  for (const name of filesWith(dir, [".yaml", ".yml"])) {
    const file = join(dir, name);
    const id = basename(name, extname(name));
    broken.add(`agent:${id}`);
    const data = readYaml(file, diagnostics);
    if (data === undefined) continue;
    const parsed = check(AgentSchema, data);
    for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
    if (!parsed.output) continue;
    if (parsed.output.id !== id) {
      diagnostics.add(file, "id", `must match the file name (${id})`);
      continue;
    }
    if (agents.has(id)) {
      diagnostics.add(file, "id", `another file already defines agent ${id}`);
      continue;
    }
    broken.delete(`agent:${id}`);
    agents.set(id, { file, agent: parsed.output });
  }
  return agents;
};

const loadWorkflows = (dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
  const workflows = new Map<string, LoadedWorkflow>();
  for (const id of entries(dir).filter((name) => isDir(join(dir, name)))) {
    const file = join(dir, id, "workflow.yaml");
    broken.add(`workflow:${id}`);
    if (!existsSync(file)) {
      diagnostics.add(file, "(file)", "is missing: every workflow folder needs one");
      continue;
    }
    const data = readYaml(file, diagnostics);
    if (data === undefined) continue;
    const parsed = check(WorkflowSchema, data);
    for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
    if (!parsed.output) continue;
    if (parsed.output.id !== id) {
      diagnostics.add(file, "id", `must match the folder name (${id})`);
      continue;
    }
    const stepsDir = join(dir, id, "steps");
    const steps = new Map(
      filesWith(stepsDir, [".md"]).map((name): [string, SourceText] => {
        const step = join(stepsDir, name);
        return [basename(name, ".md"), { file: step, text: readSafe(step, diagnostics) ?? "" }];
      }),
    );
    broken.delete(`workflow:${id}`);
    workflows.set(id, { file, workflow: parsed.output, steps });
  }
  return workflows;
};

/** A file's text, or `undefined` after reporting why it can't be read. */
const readSafe = (file: string, diagnostics: Diagnostics): string | undefined => {
  try {
    return readText(file);
  } catch (error) {
    diagnostics.add(file, "(file)", message(error));
    return undefined;
  }
};

const readOptional = (file: string, diagnostics: Diagnostics): SourceText | undefined => {
  if (!existsSync(file)) return undefined;
  const text = readSafe(file, diagnostics);
  return text === undefined ? undefined : { file, text };
};

const loadTargets = (dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
  const targets = new Map<string, LoadedTarget>();
  for (const slug of entries(dir).filter((name) => isDir(join(dir, name)))) {
    const targetDir = join(dir, slug);
    const file = join(targetDir, "target.yaml");
    broken.add(`target:${slug}`);
    if (!existsSync(file)) {
      diagnostics.add(file, "(file)", "is missing: every target folder needs one");
      continue;
    }
    const data = readYaml(file, diagnostics);
    if (data === undefined) continue;
    const parsed = check(TargetSchema, data);
    for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
    if (!parsed.output) continue;
    if (parsed.output.id !== slug) {
      diagnostics.add(file, "id", `must match the folder name (${slug})`);
      continue;
    }
    broken.delete(`target:${slug}`);
    const squad = readOptional(join(targetDir, "squad.md"), diagnostics);
    targets.set(slug, {
      file,
      dir: targetDir,
      target: parsed.output,
      templates: loadTemplates(join(targetDir, "templates"), diagnostics, broken),
      traits: loadTraits(join(targetDir, "traits"), diagnostics, broken),
      globals: loadGlobals(join(targetDir, "traits", "global"), diagnostics),
      skills: loadSkills(join(targetDir, "skills")),
      ...(squad ? { squad } : {}),
    });
  }
  return targets;
};

/** Reads every file of the setup in `dir`. Errors go to `diagnostics`, and their files are left out. */
export const loadSetup = (dir: string, diagnostics: Diagnostics): Setup => {
  const root = resolve(dir);
  const broken = new Set<string>();
  if (!isDir(root)) diagnostics.add(root, "(dir)", "is not a setup directory: it doesn't exist");
  const squad = readOptional(join(root, "squad.md"), diagnostics);
  return {
    dir: root,
    templates: loadTemplates(join(root, "templates"), diagnostics, broken),
    traits: loadTraits(join(root, "traits"), diagnostics, broken),
    globals: loadGlobals(join(root, "traits", "global"), diagnostics),
    agents: loadAgents(join(root, "agents"), diagnostics, broken),
    workflows: loadWorkflows(join(root, "workflows"), diagnostics, broken),
    targets: loadTargets(join(root, "targets"), diagnostics, broken),
    skills: loadSkills(join(root, "skills")),
    ...(squad ? { squad } : {}),
    broken,
  };
};
