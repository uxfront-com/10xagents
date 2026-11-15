// The bundled starter setup, as the Multica connector renders and checks it.

import { join } from "node:path";

import { Diagnostics, formatDiagnostic, loadSetup, renderTarget, validateSetup } from "10xagents";
import { describe, expect, it } from "vitest";

import { columnNames, mergeWorkflows, validate } from "../src/index.ts";

const STARTER = join(import.meta.dirname, "..", "..", "..", "setups", "starter");

const renderExample = () => {
  const diagnostics = new Diagnostics();
  const setup = loadSetup(STARTER, diagnostics);
  validateSetup(setup, diagnostics, { target: "example" });
  const rendered = renderTarget(setup, "example", diagnostics, {
    sharedContext: true,
    columnNames,
  });
  expect(diagnostics.list.map((diagnostic) => formatDiagnostic(diagnostic, STARTER))).toEqual([]);
  if (!rendered) throw new Error("no rendered setup");
  return rendered;
};

describe("the starter example target", () => {
  it("is one Multica can take", () => {
    expect(validate(renderExample())).toEqual([]);
  });

  it("gives Multica's Default workflow its columns, in order, with their handoffs", () => {
    const merged = mergeWorkflows(renderExample());
    expect(merged.columns.map((column) => [column.name, column.handoff])).toEqual([
      ["Backlog", "none"],
      ["Todo", "agent:lead"],
      ["In Progress", "none"],
      ["Review", "agent:reviewer"],
      ["In Review", "owner"],
      ["Blocked", "owner"],
      ["Done", "none"],
      ["Cancelled", "none"],
    ]);
  });
});
