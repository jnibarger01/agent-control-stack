import { build } from "esbuild";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Builds the ACS Mission Control SPA into apps/control-ui/dist/app. The gateway
// serves that directory under /console/*; nothing here is inlined so the page
// stays compatible with a strict `script-src 'self'` Content-Security-Policy.
const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "apps/control-ui/dist/app");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: { console: resolve(root, "apps/control-ui/app/src/main.tsx") },
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  platform: "browser",
  target: "es2022",
  outdir,
  splitting: true,
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning"
});

const files = await readdir(outdir);
const js = files.find((file) => file.startsWith("console-") && file.endsWith(".js"));
const css = files.find((file) => file.startsWith("console-") && file.endsWith(".css"));
if (!js) throw new Error("control console bundle did not produce JavaScript");
if (!css) throw new Error("control console bundle did not produce CSS");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="referrer" content="no-referrer" />
    <title>ACS Mission Control</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/console/assets/${css}" />
  </head>
  <body>
    <div id="root"></div>
    <noscript>ACS Mission Control requires JavaScript.</noscript>
    <script type="module" src="/console/assets/${js}"></script>
  </body>
</html>
`;
await writeFile(resolve(outdir, "index.html"), html);
console.log(`control console built: ${js} (${Object.keys(result.metafile.outputs).length} outputs)`);
