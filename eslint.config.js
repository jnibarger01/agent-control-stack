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
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@agent-control-stack/policy-gate",
              importNames: [
                "maybeRunJevShadowAdvisory",
                "runJevShadowAdvisory",
                "createJevRouteShadow",
                "createJevRouteShadowObserver"
              ],
              message:
                "Jev shadow hooks are advisory-only (ADR 0020, ADR 0025). Only the gateway MCP observation path and the two authoritative-claim composition roots may import them from the policy-gate barrel."
            }
          ],
          patterns: [
            {
              group: ["@agent-control-stack/jev-advisor", "@agent-control-stack/jev-advisor/*", "**/jev-advisor/**"],
              message:
                "Jev is advisory-only (ADR 0020). Import it only from the allow-listed shadow hook or observation worker, never from authority code."
            },
            {
              group: [
                "@agent-control-stack/policy-gate/*jev-shadow*",
                "**/policy-gate/src/jev-shadow.js",
                "**/policy-gate/src/jev-shadow.ts"
              ],
              message:
                "Jev shadow hooks are advisory-only (ADR 0020). Do not deep-import the shadow module from authority code."
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
      "**/*.test.{ts,mjs}"
    ],
    rules: { "no-restricted-imports": "off" }
  },
  {
    // The gateway MCP transport is the production caller of the advisory shadow hook. Keep the raw adapter forbidden
    // here while allowing the policy-gate wrapper, but not the route shadow factory (ADR 0025).
    files: ["apps/gateway/src/mcp.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@agent-control-stack/policy-gate",
              importNames: ["createJevRouteShadow", "createJevRouteShadowObserver"],
              message:
                "The Jev route shadow factory is advisory-only (ADR 0020, ADR 0025). Only the authoritative-claim composition roots may import it."
            }
          ],
          patterns: [
            {
              group: ["@agent-control-stack/jev-advisor", "@agent-control-stack/jev-advisor/*", "**/jev-advisor/**"],
              message: "Jev is advisory-only (ADR 0020). Use the policy-gate shadow hook from this observation path."
            },
            {
              group: [
                "@agent-control-stack/policy-gate/*jev-shadow*",
                "**/policy-gate/src/jev-shadow.js",
                "**/policy-gate/src/jev-shadow.ts"
              ],
              message: "Jev shadow hooks are advisory-only (ADR 0020). Use the policy-gate barrel, not a deep import."
            }
          ]
        }
      ]
    }
  },
  {
    // ADR 0025: the two authoritative-claim composition roots are the only callers of the route shadow factory.
    // The raw adapter and the shadow module deep import stay forbidden.
    files: ["apps/worker/src/index.ts", "apps/gateway/src/tools/execute-approved.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@agent-control-stack/policy-gate",
              importNames: ["maybeRunJevShadowAdvisory", "runJevShadowAdvisory"],
              message:
                "Jev shadow hooks are advisory-only (ADR 0020). Only the gateway MCP observation path may import them from the policy-gate barrel."
            }
          ],
          patterns: [
            {
              group: ["@agent-control-stack/jev-advisor", "@agent-control-stack/jev-advisor/*", "**/jev-advisor/**"],
              message:
                "Jev is advisory-only (ADR 0020). Use the policy-gate route shadow factory from this composition root."
            },
            {
              group: [
                "@agent-control-stack/policy-gate/*jev-shadow*",
                "**/policy-gate/src/jev-shadow.js",
                "**/policy-gate/src/jev-shadow.ts"
              ],
              message: "Jev shadow hooks are advisory-only (ADR 0020). Use the policy-gate barrel, not a deep import."
            }
          ]
        }
      ]
    }
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
