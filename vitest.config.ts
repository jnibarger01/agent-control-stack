import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-control-stack/moa-orchestrator": fileURLToPath(new URL("./packages/moa-orchestrator/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "harness/**/*.test.ts", "evals/**/*.test.ts"]
  }
});
