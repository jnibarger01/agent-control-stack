import { build } from "vite";
import { resolve } from "node:path";

// Keep the same gateway asset layout and same-origin CSP. Vite owns hashing,
// code splitting and the HTML manifest; source files are never served directly.
const root = resolve(import.meta.dirname, "../apps/control-ui/app");
await build({
  configFile: false,
  root,
  base: "/console/assets/",
  build: {
    outDir: resolve(root, "../dist/app"),
    emptyOutDir: true,
    assetsDir: "",
    target: "es2022",
    sourcemap: false
  }
});
