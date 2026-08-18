import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-control-stack/moa-orchestrator": fileURLToPath(
        new URL("./packages/moa-orchestrator/src/index.ts", import.meta.url)
      ),
      "@agent-control-stack/procedural-learning": fileURLToPath(
        new URL("./packages/procedural-learning/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "harness/**/*.test.ts", "evals/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["packages/**/*.ts", "apps/**/*.ts", "harness/**/*.ts", "evals/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.d.ts", "**/cli.ts"],
      thresholds: { statements: 75, branches: 70, functions: 85, lines: 75 }
    }
  }
});
