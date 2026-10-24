import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const gateway = process.env.ACS_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  base: "/next/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Bundle the shared contract from source so the SPA never depends on a prior `tsc -b`.
      "@agent-control-stack/mission-control-contract": fileURLToPath(
        new URL("../../packages/mission-control-contract/src/index.ts", import.meta.url)
      )
    }
  },
  server: {
    port: 5174,
    proxy: { "/api": gateway, "/events": gateway }
  },
  build: {
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 500
  }
});
