import { defineConfig } from "vitest/config";

// Tests import `10xagents` from its source, so they run without a build.
export default defineConfig({
  resolve: { conditions: ["@10xagents/source"] },
  ssr: { resolve: { conditions: ["@10xagents/source"] } },
});
