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
