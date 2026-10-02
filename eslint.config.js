import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.vercel/**", "coverage/**", "runs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    // ADR 0020: Jev is advisory evidence only. Only the shadow hook and the observation worker
    // may touch the adapter; everything else (authority packages, apps) must not import it.
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@agent-control-stack/jev-advisor", "@agent-control-stack/jev-advisor/*", "**/jev-advisor/**"],
              message:
                "Jev is advisory-only (ADR 0020). Import it only from the allow-listed shadow hook or observation worker, never from authority code."
            }
          ]
        }
      ]
    }
  },
  {
    files: [
      "packages/jev-advisor/**/*.ts",
      "packages/policy-gate/src/jev-shadow.ts",
      "packages/evidence/src/observation-worker.ts",
      "**/*.test.ts"
    ],
    rules: { "no-restricted-imports": "off" }
  },
  {
    // The deterministic decision modules must not depend on the Jev shadow hook either, so Jev
    // output cannot reach classification, policy, routing or approval.
    files: ["packages/policy-gate/src/**/*.ts"],
    ignores: ["packages/policy-gate/src/jev-shadow.ts", "packages/policy-gate/src/index.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@agent-control-stack/jev-advisor", "@agent-control-stack/jev-advisor/*", "**/jev-advisor/**"],
              message: "Jev is advisory-only (ADR 0020)."
            },
            {
              group: ["./jev-shadow.js", "**/jev-shadow.js"],
              message: "Policy and classification modules must not import the Jev shadow hook (ADR 0020)."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly"
      }
    }
  },
  {
    // Imported Desktop Commander gateway and relay (plain Node ESM): declare
    // the additional Node/web globals they use rather than relaxing no-undef.
    files: ["apps/dc-mcp-gateway/**/*.js", "apps/dc-mcp-gateway/**/*.mjs", "apps/dc-relay/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      globals: {
        setInterval: "readonly",
        setImmediate: "readonly",
        clearInterval: "readonly",
        structuredClone: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly"
      }
    }
  }
);
