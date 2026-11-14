import { defineCommand } from "citty";
import type { CommandDef } from "citty";

import pkg from "../package.json" with { type: "json" };

export const main: CommandDef = defineCommand({
  meta: {
    name: "10xagents",
    version: pkg.version,
    description: pkg.description,
  },
});
