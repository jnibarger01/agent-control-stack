import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workload } from "./datasets.mjs";

const installed = mkdtempSync(join(tmpdir(), "acs-integration-graph-package-"));
const workspace = new URL("../../packages/integration-manager/", import.meta.url);
const addon = "acs_integration_graph.node";
const child = `
  import { readFileSync, existsSync } from "node:fs";
  import { createRequire } from "node:module";
  import { analyzeDependencies, findOverlaps } from "./dist/graph-backend.js";
  const require = createRequire(import.meta.url);
  let calls = 0;
  if (existsSync("./native/${addon}")) {
    const native = require("./native/${addon}");
    for (const name of ["analyzeDependencies", "findOverlaps"]) {
      const real = native[name];
      native[name] = (...args) => { calls++; return real(...args); };
    }
  }
  const prs = JSON.parse(readFileSync(0, "utf8"));
  const analysis = analyzeDependencies(prs, "main");
  const ordered = JSON.stringify({ ...analysis,
    dependsOn: [...analysis.dependsOn], cyclic: [...analysis.cyclic],
    blockedByCycle: [...analysis.blockedByCycle], detached: [...analysis.detached],
    overlaps: [...findOverlaps(prs)]
  });
  console.log(JSON.stringify({ ordered, calls }));
`;

function run(backend) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    cwd: installed,
    env: backend ? { ACS_INTEGRATION_GRAPH_BACKEND: backend } : {},
    input: JSON.stringify(workload(24)),
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return { ...JSON.parse(result.stdout), warnings: result.stderr };
}

try {
  writeFileSync(join(installed, "package.json"), '{"type":"module"}\n');
  mkdirSync(join(installed, "dist"));
  mkdirSync(join(installed, "native"));
  for (const path of ["dist/graph.js", "dist/graph-backend.js", "native/bridge.cjs"]) {
    copyFileSync(new URL(path, workspace), join(installed, path));
  }
  const fallback = run("rust");
  assert.equal(fallback.calls, 0);
  assert.match(fallback.warnings, /ACS_INTEGRATION_GRAPH_LOAD/u);

  copyFileSync(new URL(addon, import.meta.url), join(installed, "native", addon));
  const native = run("rust");
  assert.equal(native.calls, 2);
  assert.equal(native.warnings, "");
  assert.equal(native.ordered, fallback.ordered);

  const rolledBack = run();
  assert.equal(rolledBack.calls, 0);
  assert.equal(rolledBack.warnings, "");
  assert.equal(rolledBack.ordered, native.ordered);
  console.log("Compiled package smoke passed for missing addon, opted-in native calls, and fresh-process rollback.");
} finally {
  rmSync(installed, { recursive: true, force: true });
}
