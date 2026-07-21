import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-control-stack/moa-orchestrator": fileURLToPath(new URL("./packages/moa-orchestrator/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "harness/**/*.test.ts", "evals/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/**/*.ts", "apps/**/*.ts", "harness/**/*.ts", "evals/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.d.ts", "**/cli.ts"],
      thresholds: { statements: 75, branches: 70, functions: 85, lines: 75 }
    }
  }
});
