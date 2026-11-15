// The schemas of a setup's files: agents, traits, templates, workflows and targets.

import * as v from "valibot";

/** An id: lower case, digits, `-` and `_`, starting with a letter or digit. */
const Id = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lower case letters, digits, - and _"),
);
const Text = v.pipe(v.string(), v.minLength(1, "must not be empty"));
const Scalar = v.union(
  [v.string(), v.number(), v.boolean()],
  "must be text, a number or a boolean",
);

export type Scalar = string | number | boolean;

/** Code points, as the platforms count them, not UTF-16 units. */
const length = (text: string): number => Array.from(text).length;

export const MAX_DESCRIPTION = 255;

const TraitRefSchema = v.union(
  [Id, v.strictObject({ id: Id, params: v.optional(v.record(v.string(), Scalar), {}) })],
  "must be a trait id, or { id, params }",
);

export const AgentSchema = v.strictObject({
  id: Id,
  name: Text,
  description: v.pipe(
    v.string(),
    v.check(
      (text) => length(text) <= MAX_DESCRIPTION,
      (issue) => `must be at most ${MAX_DESCRIPTION} characters (it has ${length(issue.input)})`,
    ),
  ),
  template: v.optional(Id),
  model: v.strictObject({ id: Text, thinking: Text }),
  concurrency: v.pipe(
    v.number(),
    v.integer("must be a whole number"),
    v.minValue(1, "must be 1 or more"),
  ),
  skills: v.optional(v.array(Text), []),
  squad: v.optional(v.strictObject({ role: v.optional(Text) })),
  sections: v.optional(v.record(Id, v.string()), {}),
  traits: v.optional(v.array(TraitRefSchema), []),
});
export type Agent = v.InferOutput<typeof AgentSchema>;
export type TraitRef = v.InferOutput<typeof TraitRefSchema>;

const ParamType = v.picklist(["string", "number", "boolean"], "must be string, number or boolean");
const ParamSchema = v.union(
  [ParamType, v.strictObject({ type: ParamType, default: v.optional(Scalar) })],
  "must be a type (string, number or boolean), or { type, default }",
);
export type ParamDecl = v.InferOutput<typeof ParamSchema>;

/** An opt-in trait's frontmatter. */
export const TraitSchema = v.strictObject({
  section: Id,
  params: v.optional(v.record(Id, ParamSchema), {}),
});

/** A template's frontmatter. The keys of `slots` are the slot ids. */
export const TemplateSchema = v.strictObject({
  slots: v.record(
    Id,
    v.strictObject({ heading: v.optional(Text), required: v.optional(v.boolean(), false) }),
  ),
});
export type TemplateMeta = v.InferOutput<typeof TemplateSchema>;

const Handoff = v.pipe(
  v.string(),
  v.regex(/^(agent:[a-z0-9][a-z0-9_-]*|owner|none)$/, "must be agent:<id>, owner or none"),
);

export const ColumnSchema = v.strictObject({
  key: Id,
  name: v.optional(Text),
  category: v.optional(Text),
  handoff: Handoff,
  next: v.optional(Id),
  back: v.optional(Id),
  builders: v.optional(v.array(Id)),
});
export type Column = v.InferOutput<typeof ColumnSchema>;

export const WorkflowSchema = v.strictObject({
  id: Id,
  entry: Id,
  columns: v.pipe(v.array(ColumnSchema), v.minLength(1, "must list at least one column")),
});
export type Workflow = v.InferOutput<typeof WorkflowSchema>;

const OverrideSchema = v.union(
  [v.strictObject({ replace: Text }), v.strictObject({ append: Text })],
  "must be { replace: <file> } or { append: <file> }",
);
export type Override = v.InferOutput<typeof OverrideSchema>;

export const TargetSchema = v.strictObject({
  id: Id,
  workspace: v.optional(Text),
  connector: Id,
  template: v.optional(Id),
  workflows: v.optional(v.array(Id), []),
  agents: v.array(Id),
  vars: v.optional(
    v.record(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/, "must be a plain name")), Scalar),
    {},
  ),
  squad: v.optional(v.strictObject({ name: Text, leader: Id, instructions: v.optional(Text) })),
  overrides: v.optional(v.record(v.string(), OverrideSchema), {}),
});
export type Target = v.InferOutput<typeof TargetSchema>;

/** The only fields of a target that `bench` reads. It ignores the rest. */
export const BenchTargetSchema = v.object({
  id: Id,
  workspace: v.optional(Text),
  connector: Id,
});

/** A schema error, as a field path and a message. */
export interface SchemaIssue {
  field: string;
  message: string;
}

const fieldOf = (issue: v.BaseIssue<unknown>): string => {
  let field = "";
  for (const item of issue.path ?? []) {
    const key: unknown = item.key;
    field += typeof key === "number" ? `[${key}]` : `${field ? "." : ""}${String(key)}`;
  }
  return field || "(root)";
};

const messageOf = (issue: v.BaseIssue<unknown>): string => {
  // A strict object reports an unknown key as "Expected never".
  if (issue.expected === "never") return "is not a known field";
  if (issue.input === undefined) return "is required";
  return issue.message;
};

/** Parses `input`, and turns valibot's issues into one entry per field. */
export const check = <S extends v.GenericSchema>(
  schema: S,
  input: unknown,
): { output?: v.InferOutput<S>; issues: SchemaIssue[] } => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { issues: [{ field: "(root)", message: "must be a mapping of fields" }] };
  }
  const result = v.safeParse(schema, input);
  if (result.success) return { output: result.output, issues: [] };
  return {
    issues: result.issues.map((issue) => ({ field: fieldOf(issue), message: messageOf(issue) })),
  };
};
