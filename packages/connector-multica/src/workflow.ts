// A target's workflows, merged into the one Default workflow Multica gives a workspace.
//
// Multica attaches workflows to projects, and an issue has no workflow of its own, so every
// workflow of a target goes into one. The first keeps its column names. Every later one's
// custom columns are named `<prefix> <Column>`, where the prefix is the workflow's `prefix`, or
// its id in title case (`Part Planning`). A new workspace derives each status's key from its
// first name (`part_planning`), and a renamed status keeps its key. Built-in columns, like Todo
// and Done, are shared.

import type {
  ColumnNames,
  ConnectorIssue,
  RenderedColumn,
  RenderedSetup,
  Workflow,
} from "10xagents";

import { length } from "./text.ts";

/** Multica's built-in statuses, by key, with their names. */
export const BUILT_IN: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
const isBuiltIn = (key: string): boolean => Object.hasOwn(BUILT_IN, key);

/** Multica keeps these first, in this order. */
const HEAD = ["backlog", "todo"];
/** Multica keeps these last, in this order. */
const TAIL = ["blocked", "done", "cancelled"];
const FIXED = [...HEAD, ...TAIL];
/** Every workflow has these. */
const REQUIRED = ["todo", "done", "cancelled"];
/** These take no handoff. */
const NO_HANDOFF = new Set(["backlog", "done", "cancelled"]);

/** The most characters Multica takes in a status's name. */
export const MAX_NAME = 64;
/** The most characters Multica takes in a step's instructions. */
export const MAX_STEP = 8000;
/** The most characters Multica takes in an agent's description. */
export const MAX_DESCRIPTION = 255;
/** The category a custom column gets when its workflow gives none. */
export const DEFAULT_CATEGORY = "started";

/** `plan_review` → `Plan Review`. */
export const titleCase = (key: string): string =>
  key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");

/**
 * The Multica name of each column: a built-in column's own, the first workflow's custom columns
 * by their `name` (or their key, in title case), and every later workflow's prefixed with the
 * workflow's `prefix`, or its id in title case. The first workflow's `prefix` is ignored, so a
 * workflow can come first in one target and later in another.
 */
export const columnNames = (workflows: readonly Workflow[]): ColumnNames =>
  Object.fromEntries(
    workflows.map((workflow, index) => [
      workflow.id,
      Object.fromEntries(
        workflow.columns.map((column) => {
          const builtIn = BUILT_IN[column.key];
          if (builtIn !== undefined) return [column.key, builtIn];
          const own = column.name ?? titleCase(column.key);
          const prefix = workflow.prefix ?? titleCase(workflow.id);
          return [column.key, index === 0 ? own : `${prefix} ${own}`];
        }),
      ),
    ]),
  );

/** One column of the merged workflow. */
export interface MergedColumn {
  /** Its Multica name. */
  name: string;
  /** Its key, for a built-in column. Multica gives a custom column's key. */
  key?: string;
  /** Its category, for a custom column. */
  category?: string;
  /** `agent:<id>`, `owner` or `none`. */
  handoff: string;
  instructions?: string;
  /** Where `next` and `back` move to, as places in the merged list. */
  next?: number;
  back?: number;
  /** The workflow and key of each column it came from: two for a shared built-in column. */
  from: { workflow: string; key: string }[];
}

export interface Merged {
  columns: MergedColumn[];
  issues: ConnectorIssue[];
}

const ref = (workflow: string, key: string): string => `${workflow}\0${key}`;

const toColumn = (workflow: string, column: RenderedColumn): MergedColumn => ({
  name: column.name,
  ...(isBuiltIn(column.key)
    ? { key: column.key }
    : { category: column.category ?? DEFAULT_CATEGORY }),
  handoff: column.handoff,
  ...(column.instructions === undefined ? {} : { instructions: column.instructions }),
  from: [{ workflow, key: column.key }],
});

/** Merges `rendered`'s workflows, in Multica's order, and reports what can't merge. */
export const mergeWorkflows = (rendered: RenderedSetup): Merged => {
  const issues: ConnectorIssue[] = [];
  const workflows = rendered.workflows;
  // Places first, so moves can point forward.
  const place = new Map<string, number>();
  const columns: MergedColumn[] = [];
  const shared = new Map<string, number>();
  const add = (workflow: string, key: string, column: MergedColumn) => {
    const builtIn = isBuiltIn(key);
    const existing = builtIn ? shared.get(key) : undefined;
    if (existing !== undefined) {
      place.set(ref(workflow, key), existing);
      columns[existing]?.from.push({ workflow, key });
      return;
    }
    place.set(ref(workflow, key), columns.length);
    if (builtIn) shared.set(key, columns.length);
    columns.push(column);
  };
  const all = workflows.flatMap((workflow) =>
    workflow.columns.map((column) => ({ workflow: workflow.id, column })),
  );
  for (const key of HEAD) {
    for (const { workflow, column } of all.filter((item) => item.column.key === key)) {
      add(workflow, key, toColumn(workflow, column));
    }
  }
  for (const { workflow, column } of all.filter((item) => !FIXED.includes(item.column.key))) {
    add(workflow, column.key, toColumn(workflow, column));
  }
  for (const key of TAIL) {
    for (const { workflow, column } of all.filter((item) => item.column.key === key)) {
      add(workflow, key, toColumn(workflow, column));
    }
  }

  // Moves, and what two workflows say differently about a shared column.
  const seen = new Set<number>();
  for (const { workflow, column } of all) {
    const at = place.get(ref(workflow, column.key));
    const merged = at === undefined ? undefined : columns[at];
    if (at === undefined || !merged) continue;
    const next = column.next === undefined ? undefined : place.get(ref(workflow, column.next));
    const back = column.back === undefined ? undefined : place.get(ref(workflow, column.back));
    if (!seen.has(at)) {
      seen.add(at);
      if (next !== undefined) merged.next = next;
      if (back !== undefined) merged.back = back;
      continue;
    }
    const first = merged.from[0];
    const conflicts = [
      column.handoff !== merged.handoff ? "handoff" : "",
      (column.instructions ?? "") !== (merged.instructions ?? "") ? "step text" : "",
      next !== merged.next ? "next" : "",
      back !== merged.back ? "back" : "",
    ].filter(Boolean);
    if (conflicts.length > 0 && first) {
      issues.push({
        field: `workflows.${workflow}.columns.${column.key}`,
        message: `${merged.name} is shared with workflow ${first.workflow}, which gives it another ${conflicts.join(", ")}: Multica has one ${merged.name}, so give both the same`,
      });
    }
  }
  return { columns, issues };
};

/** What Multica would refuse in a target's workflows, or would put back another way. */
export const checkWorkflows = (rendered: RenderedSetup, merged: Merged): ConnectorIssue[] => {
  const issues: ConnectorIssue[] = [...merged.issues];
  for (const workflow of rendered.workflows) {
    const field = (key: string) => `workflows.${workflow.id}.columns.${key}`;
    const keys = workflow.columns.map((column) => column.key);
    // Multica would put fixed columns back in their places, and the sync would then find a
    // change on every run.
    const fixed = keys.filter((key) => FIXED.includes(key));
    const expected = FIXED.filter((key) => keys.includes(key));
    const firstMiddle = keys.findIndex((key) => !FIXED.includes(key));
    const lastMiddle = keys.findLastIndex((key) => !FIXED.includes(key));
    const lastHead = Math.max(-1, ...HEAD.map((key) => keys.indexOf(key)));
    const tailPlaces = TAIL.map((key) => keys.indexOf(key)).filter((index) => index >= 0);
    const firstTail = Math.min(keys.length, ...tailPlaces);
    if (
      fixed.join() !== expected.join() ||
      (firstMiddle >= 0 && (lastHead > firstMiddle || firstTail < lastMiddle))
    ) {
      issues.push({
        field: `workflows.${workflow.id}.columns`,
        message:
          "list backlog and todo first, and blocked, done and cancelled last, as Multica does",
      });
    }
    for (const column of workflow.columns) {
      if (NO_HANDOFF.has(column.key) && column.handoff !== "none") {
        issues.push({
          field: `${field(column.key)}.handoff`,
          message: `Multica hands nothing off in ${BUILT_IN[column.key]}: make it none`,
        });
      }
      const size = length(column.instructions ?? "");
      if (size > MAX_STEP) {
        issues.push({
          field: `workflows.${workflow.id}.steps.${column.key}`,
          message: `is ${size} characters, over Multica's ${MAX_STEP}`,
        });
      }
    }
  }
  const keys = new Set(merged.columns.flatMap((column) => (column.key ? [column.key] : [])));
  for (const key of REQUIRED) {
    if (!keys.has(key)) {
      issues.push({
        field: "workflows",
        message: `no workflow has a ${key} column, and Multica needs one`,
      });
    }
  }
  const names = new Map<string, MergedColumn>();
  const builtInNames = new Set(Object.values(BUILT_IN).map((name) => name.toLowerCase()));
  for (const column of merged.columns) {
    if (column.key) continue;
    const from = column.from[0];
    const field = from ? `workflows.${from.workflow}.columns.${from.key}.name` : "workflows";
    const size = length(column.name);
    if (size > MAX_NAME) {
      issues.push({ field, message: `is ${size} characters, over Multica's ${MAX_NAME}` });
    }
    const lower = column.name.toLowerCase();
    const earlier = names.get(lower);
    if (builtInNames.has(lower)) {
      issues.push({ field, message: `${column.name} is the name of a built-in Multica status` });
    } else if (earlier) {
      const other = earlier.from[0];
      issues.push({
        field,
        message: `${column.name} is also the name of ${other ? `workflow ${other.workflow}'s ${other.key}` : "another column"}: Multica names a status once`,
      });
    } else names.set(lower, column);
  }
  return issues;
};
