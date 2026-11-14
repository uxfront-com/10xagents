// The steps a merged workflow sends to `multica workflow update`, and how they line up with
// what Multica returns.

import { BUILT_IN } from "./workflow.ts";

/** A handler as Multica takes it. A column without one hands nothing off. */
export interface Handler {
  type: "agent" | "member";
  id: string;
}

/** One column, ready to write: its handler resolved, its moves as places in the list. */
export interface StepSpec {
  name: string;
  key?: string;
  category?: string;
  handler?: Handler;
  instructions: string;
  next?: number;
  back?: number;
}

/** One step as `workflow update --steps-file` takes it. */
export interface Step {
  status_key?: string;
  new_status?: { name: string; category: string };
  handler?: Handler;
  instructions?: string;
  next_status_key?: string;
  back_status_key?: string;
}

const builtInKeys = new Set(Object.keys(BUILT_IN));

/**
 * The custom columns' status keys, by place. Multica keeps a workflow's steps in the order
 * written, and a key says nothing about its status's name, since a renamed status keeps its
 * key. So the n-th custom key is the n-th custom column's, and when the counts differ, none is
 * known.
 */
export const customKeys = (
  liveKeys: readonly string[],
  specs: readonly StepSpec[],
): Map<number, string> => {
  const custom = liveKeys.filter((key) => !builtInKeys.has(key));
  const places = specs.flatMap((spec, index) => (spec.key ? [] : [index]));
  if (custom.length !== places.length) return new Map();
  return new Map(places.map((place, index) => [place, custom[index] ?? ""]));
};

/** The status key of the column at `place`, when it's known. */
export const keyAt = (
  specs: readonly StepSpec[],
  keys: ReadonlyMap<number, string>,
  place: number,
): string | undefined => specs[place]?.key ?? keys.get(place);

/**
 * One step as Multica takes it: by key, or by name for a custom column whose key isn't known
 * (Multica reuses the status with that name, or creates it), with its handoff and the moves
 * whose target has a key.
 */
export const stepFor = (
  specs: readonly StepSpec[],
  keys: ReadonlyMap<number, string>,
  place: number,
): Step => {
  const spec = specs[place];
  if (!spec) throw new Error(`no column at ${place}`);
  const key = keyAt(specs, keys, place);
  const step: Step = key
    ? { status_key: key }
    : { new_status: { name: spec.name, category: spec.category ?? "started" } };
  if (spec.handler) {
    step.handler = spec.handler;
    step.instructions = spec.instructions;
  }
  const next = spec.next === undefined ? undefined : keyAt(specs, keys, spec.next);
  const back = spec.back === undefined ? undefined : keyAt(specs, keys, spec.back);
  if (next) step.next_status_key = next;
  if (back) step.back_status_key = back;
  return step;
};

/** Every step, in order. */
export const stepsFor = (specs: readonly StepSpec[], keys: ReadonlyMap<number, string>): Step[] =>
  specs.map((_, place) => stepFor(specs, keys, place));
