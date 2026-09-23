import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.vercel/**", "coverage/**", "runs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    // Mission Control SPA: browser code (TSX) and its Chrome-driven end-to-end scripts.
    files: ["apps/control-ui/app/**/*.tsx", "apps/control-ui/app/**/*.ts", "apps/control-ui/app/e2e/**/*.mjs"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        location: "readonly",
        getComputedStyle: "readonly",
        history: "readonly",
        WebSocket: "readonly",
        Event: "readonly",
        KeyboardEvent: "readonly",
        PopStateEvent: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        Function: "readonly",
        Promise: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly"
      }
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
  }
);
