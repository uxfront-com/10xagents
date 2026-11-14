import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  platform: "node",
  // `bin/10xagents.mjs` imports `dist/cli.mjs`, whatever the package's `type`.
  fixedExtension: true,
  dts: true,
});

export default config;
