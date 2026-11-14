// Reads a setup from a local directory, and merges the layers of a setup that extends others.

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

/** A skill: a folder under `skills/`, with its `SKILL.md`. */
export interface Skill {
  id: string;
  dir: string;
}

export interface LoadedTarget {
  file: string;
  dir: string;
  /** The folder of the setup layer the target comes from. Its files stay inside it. */
  root: string;
  target: Target;
  templates: Map<string, Template>;
  traits: Map<string, Trait>;
  globals: GlobalTrait[];
  skills: Map<string, Skill>;
  squad?: SourceText;
}

export interface Setup {
  /** The folder of the top layer: the setup itself. */
  dir: string;
  /** Every layer's folder, the one that wins first. */
  layers: string[];
  templates: Map<string, Template>;
  traits: Map<string, Trait>;
  globals: GlobalTrait[];
  agents: Map<string, LoadedAgent>;
  workflows: Map<string, LoadedWorkflow>;
  targets: Map<string, LoadedTarget>;
  skills: Map<string, Skill>;
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

/** A workflow folder with steps and no `workflow.yaml`: it changes an extended workflow's steps. */
interface StepsOnly {
  /** The missing `workflow.yaml`. */
  file: string;
  steps: Map<string, SourceText>;
}

const loadSteps = (stepsDir: string, diagnostics: Diagnostics): Map<string, SourceText> =>
  new Map(
    filesWith(stepsDir, [".md"]).map((name): [string, SourceText] => {
      const step = join(stepsDir, name);
      return [basename(name, ".md"), { file: step, text: readSafe(step, diagnostics) ?? "" }];
    }),
  );

const loadWorkflows = (
  dir: string,
  diagnostics: Diagnostics,
  broken: Set<string>,
  stepsOnly: Map<string, StepsOnly>,
) => {
  const workflows = new Map<string, LoadedWorkflow>();
  for (const id of entries(dir).filter((name) => isDir(join(dir, name)))) {
    const file = join(dir, id, "workflow.yaml");
    if (!existsSync(file)) {
      stepsOnly.set(id, { file, steps: loadSteps(join(dir, id, "steps"), diagnostics) });
      continue;
    }
    broken.add(`workflow:${id}`);
    const data = readYaml(file, diagnostics);
    if (data === undefined) continue;
    const parsed = check(WorkflowSchema, data);
    for (const issue of parsed.issues) diagnostics.add(file, issue.field, issue.message);
    if (!parsed.output) continue;
    if (parsed.output.id !== id) {
      diagnostics.add(file, "id", `must match the folder name (${id})`);
      continue;
    }
    const steps = loadSteps(join(dir, id, "steps"), diagnostics);
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

const loadSkills = (dir: string): Map<string, Skill> =>
  new Map(
    entries(dir)
      .filter((name) => isDir(join(dir, name)))
      .map((id): [string, Skill] => [id, { id, dir: join(dir, id) }]),
  );

const loadTargets = (root: string, dir: string, diagnostics: Diagnostics, broken: Set<string>) => {
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
      root,
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

/** One layer of a setup: its own files, before the layers under it are merged in. */
export interface Layer extends Omit<Setup, "layers"> {
  /** Workflow folders with steps and no `workflow.yaml`, by workflow id. */
  stepsOnly: Map<string, StepsOnly>;
}

/** Reads every file of the setup layer in `dir`. Errors go to `diagnostics`. */
export const loadLayer = (dir: string, diagnostics: Diagnostics): Layer => {
  const root = resolve(dir);
  const broken = new Set<string>();
  const stepsOnly = new Map<string, StepsOnly>();
  if (!isDir(root)) diagnostics.add(root, "(dir)", "is not a setup directory: it doesn't exist");
  const squad = readOptional(join(root, "squad.md"), diagnostics);
  return {
    dir: root,
    templates: loadTemplates(join(root, "templates"), diagnostics, broken),
    traits: loadTraits(join(root, "traits"), diagnostics, broken),
    globals: loadGlobals(join(root, "traits", "global"), diagnostics),
    agents: loadAgents(join(root, "agents"), diagnostics, broken),
    workflows: loadWorkflows(join(root, "workflows"), diagnostics, broken, stepsOnly),
    targets: loadTargets(root, join(root, "targets"), diagnostics, broken),
    skills: loadSkills(join(root, "skills")),
    ...(squad ? { squad } : {}),
    broken,
    stepsOnly,
  };
};

/**
 * Merges layers into one setup. `layers[0]` is the setup itself, and each later layer is one it
 * extends, in the order they lose. An item resolves by id in the first layer that has it, and
 * replaces the same item of every later layer whole. A workflow folder with only `steps/` changes
 * those steps of the workflow a later layer defines.
 */
export const mergeLayers = (layers: readonly Layer[], diagnostics: Diagnostics): Setup => {
  const broken = new Set<string>();
  /** Each id from the first layer that has it, loaded or broken. */
  const pick = <T>(kind: string, of: (layer: Layer) => Map<string, T>): Map<string, T> => {
    const items = new Map<string, T>();
    const decided = new Set<string>();
    for (const layer of layers) {
      for (const [id, item] of of(layer)) {
        if (decided.has(id)) continue;
        decided.add(id);
        items.set(id, item);
      }
      for (const key of layer.broken) {
        const id = key.slice(kind.length + 1);
        if (!key.startsWith(`${kind}:`) || decided.has(id)) continue;
        decided.add(id);
        broken.add(key);
      }
    }
    return items;
  };

  // Workflows: the first layer with a `workflow.yaml` owns one, and the layers above it change steps.
  const workflows = new Map<string, LoadedWorkflow>();
  const owner = new Map<string, number>();
  layers.forEach((layer, index) => {
    const brokenIds = [...layer.broken]
      .filter((key) => key.startsWith("workflow:"))
      .map((key) => key.slice("workflow:".length));
    for (const id of [...layer.workflows.keys(), ...brokenIds]) {
      if (owner.has(id)) continue;
      owner.set(id, index);
      const loaded = layer.workflows.get(id);
      if (!loaded) {
        broken.add(`workflow:${id}`);
        continue;
      }
      const steps = new Map(loaded.steps);
      for (const above of layers.slice(0, index).toReversed()) {
        for (const [key, step] of above.stepsOnly.get(id)?.steps ?? []) steps.set(key, step);
      }
      workflows.set(id, { ...loaded, steps });
    }
  });
  for (const layer of layers) {
    for (const [id, { file }] of layer.stepsOnly) {
      if (owner.has(id)) continue;
      diagnostics.add(
        file,
        "(file)",
        layers.length > 1
          ? "is missing, and no extended setup has this workflow"
          : "is missing: every workflow folder needs one",
      );
      broken.add(`workflow:${id}`);
    }
  }

  const globals = [
    ...pick("global", (layer) => new Map(layer.globals.map((g) => [g.id, g]))).values(),
  ];
  const top = layers[0];
  const squad = layers.find((layer) => layer.squad)?.squad;
  return {
    dir: top?.dir ?? "",
    layers: layers.map((layer) => layer.dir),
    templates: pick("template", (layer) => layer.templates),
    traits: pick("trait", (layer) => layer.traits),
    globals: globals.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    agents: pick("agent", (layer) => layer.agents),
    workflows,
    targets: pick("target", (layer) => layer.targets),
    skills: pick("skill", (layer) => layer.skills),
    ...(squad ? { squad } : {}),
    broken,
  };
};

/** Reads every file of the setup in `dir`, without the setups it extends. */
export const loadSetup = (dir: string, diagnostics: Diagnostics): Setup =>
  mergeLayers([loadLayer(dir, diagnostics)], diagnostics);
