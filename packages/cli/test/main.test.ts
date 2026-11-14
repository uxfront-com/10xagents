import { renderUsage } from "citty";
import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };
import { main } from "../src/main.ts";

describe("10xagents", () => {
  it("names itself and its version in the help", async () => {
    const usage = await renderUsage(main);

    expect(usage).toContain("10xagents");
    expect(usage).toContain(pkg.version);
  });
});
