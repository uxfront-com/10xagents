// Markdown with frontmatter, and the `{{…}}` references inside text.

import { parse } from "yaml";

import type { Scalar } from "./schema.ts";

export interface Frontmatter {
  /** The parsed frontmatter, or `undefined` when the file has none. */
  data: unknown;
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n?---(?:\n|$)/;

/** Unix line ends, and no byte-order mark. */
export const normalize = (text: string): string => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

/** Splits a Markdown file into its YAML frontmatter and its body. Throws on invalid YAML. */
export const splitFrontmatter = (text: string): Frontmatter => {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: undefined, body: text };
  return { data: parse(match[1] ?? "") ?? {}, body: text.slice(match[0].length) };
};

/** What the references in one piece of text can see. */
export interface Scope {
  /** The target's slug, for messages. */
  target: string;
  vars: Readonly<Record<string, Scalar>>;
  /** The platform name of each workflow's entry and columns. */
  workflows: ReadonlyMap<string, { entry: string; columns: ReadonlyMap<string, string> }>;
  /** `{{agent.*}}`: only in an agent's own text, its traits and its template. */
  agent?: Readonly<Record<string, unknown>>;
  /** `{{params.*}}`: only in an opt-in trait. The trait's id comes first. */
  params?: { trait: string; values: Readonly<Record<string, Scalar>> };
  /** `{{slot:<id>}}`: only in a template. */
  slot?: (id: string) => string | undefined;
  /** `{{global}}`: only in a template. */
  global?: () => string;
}

const REFERENCE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Replaces every `{{…}}` in `text`. A reference that doesn't resolve is reported and left as it
 * is, so one run finds every error.
 */
export const interpolate = (
  text: string,
  scope: Scope,
  report: (message: string) => void,
): string =>
  text.replace(REFERENCE, (whole, expression: string) => {
    const value = resolve(expression, scope);
    if (typeof value === "string") return value;
    report(`{{${expression}}} ${value.error}`);
    return whole;
  });

const resolve = (expression: string, scope: Scope): string | { error: string } => {
  if (expression === "global") {
    return scope.global ? scope.global() : { error: "only works in a template" };
  }
  if (expression.startsWith("slot:")) {
    if (!scope.slot) return { error: "only works in a template" };
    const value = scope.slot(expression.slice("slot:".length));
    return value ?? { error: "is not a slot of the template" };
  }
  const [head, ...path] = expression.split(".");
  switch (head) {
    case "vars": {
      const value = path.length === 1 ? scope.vars[path[0] ?? ""] : undefined;
      return value === undefined || !Object.hasOwn(scope.vars, path[0] ?? "")
        ? { error: `is not defined by target ${scope.target}` }
        : String(value);
    }
    case "agent": {
      if (!scope.agent) return { error: "only works in an agent's sections, traits and template" };
      let value: unknown = scope.agent;
      for (const key of path) {
        value =
          value && typeof value === "object" && Object.hasOwn(value, key)
            ? Object.entries(value).find(([name]) => name === key)?.[1]
            : undefined;
      }
      return isScalar(value) && path.length > 0
        ? String(value)
        : { error: "is not a text field of the agent" };
    }
    case "params": {
      if (!scope.params) return { error: "only works in an opt-in trait" };
      const name = path.length === 1 ? (path[0] ?? "") : "";
      return Object.hasOwn(scope.params.values, name)
        ? String(scope.params.values[name])
        : { error: `is not a param of trait ${scope.params.trait}` };
    }
    case "workflows": {
      const [id = "", kind, key, ...rest] = path;
      const workflow = scope.workflows.get(id);
      if (!workflow) return { error: `names a workflow target ${scope.target} doesn't use` };
      if (kind === "entry" && key === undefined) return workflow.entry;
      if (kind === "columns" && key !== undefined && rest.length === 0) {
        return workflow.columns.get(key) ?? { error: `names a column workflow ${id} doesn't have` };
      }
      return { error: "must be workflows.<id>.entry or workflows.<id>.columns.<key>" };
    }
    default:
      return { error: "is not a known reference (vars, agent, params or workflows)" };
  }
};

/**
 * Joins pieces of text with one blank line, each trimmed, leaving out empty ones. The result has
 * no trailing newline.
 */
export const joinBlocks = (pieces: readonly string[]): string =>
  pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join("\n\n");
