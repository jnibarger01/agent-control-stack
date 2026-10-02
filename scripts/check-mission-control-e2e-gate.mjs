#!/usr/bin/env node
/**
 * Gate for the Mission Control browser verification harness.
 *
 * `scripts/verify-mission-control.mjs` requires Playwright and a Chromium build, so
 * it cannot run on every `npm run check`. Previously nothing referenced it at all,
 * which meant the coverage it provides was unenforced: it could rot, double-close
 * the gateway, or stop being reachable, and no check would notice.
 *
 * This gate runs as part of `npm run check` and enforces the parts that do not need
 * a browser:
 *
 *   1. the harness is reachable from a documented npm script;
 *   2. its documented environment contract is still declared;
 *   3. it does not close the gateway more than once;
 *   4. it still performs the checks the documentation claims.
 *
 * Set ACS_UI_E2E=1 to additionally run the harness itself. This follows the same
 * optional-dependency pattern as ACS_SANDBOX_INTEGRATION for the sandbox suite.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessPath = path.join(root, "scripts", "verify-mission-control.mjs");
const harness = readFileSync(harnessPath, "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];

const check = (label, condition, detail) => {
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
};

// 1. Reachability. The harness must be runnable through a named script, otherwise
//    the coverage is unenforced by construction.
check(
  "harness is wired into package scripts",
  typeof pkg.scripts?.["test:mission-control-e2e"] === "string",
  "missing scripts.test:mission-control-e2e"
);

// 2. Documented environment contract.
for (const variable of ["ACS_UI_EVIDENCE_DIR", "ACS_PLAYWRIGHT_MODULE", "ACS_BROWSER_EXECUTABLE"]) {
  check(`harness honours ${variable}`, harness.includes(variable), "variable is no longer read by the harness");
}

// 3. No double-close. Shutting the gateway down mid-run to prove the browser marks
//    data stale, and closing it again in the finally block, throws on the second
//    close. Require a single idempotent shutdown helper.
const closeCalls = [...harness.matchAll(/await app\.close\(\)/gu)].length;
check(
  "harness closes the gateway exactly once",
  closeCalls === 1,
  `found ${closeCalls} app.close() calls; every shutdown must go through the single idempotent helper`
);
check("harness declares an idempotent shutdown helper", /async function closeApp\(\)/u.test(harness));
check("harness shutdown helper is idempotent", /if \(appClosed\) return;/u.test(harness));

// 4. The coverage the documentation claims must still be asserted by the harness.
for (const [label, pattern] of [
  ["responsive multi-width sweep", /Responsive eleven views/u],
  ["stale-state after stream loss", /Stream loss marks data stale/u],
  ["authentication fails closed", /Read and mutation authentication fail closed/u],
  ["accessibility checks", /\baxe\b/u]
]) {
  check(`harness still covers ${label}`, pattern.test(harness));
}

// 5. Optionally execute the harness for real.
if (process.env.ACS_UI_E2E === "1") {
  process.stdout.write("ACS_UI_E2E=1: running the Mission Control browser harness\n");
  const evidence = process.env.ACS_UI_EVIDENCE_DIR;
  if (!evidence) failures.push("ACS_UI_E2E=1 requires ACS_UI_EVIDENCE_DIR to point at an output directory");
  else {
    const run = spawnSync(process.execPath, [harnessPath], {
      stdio: "inherit",
      env: { ...process.env, ACS_UI_EVIDENCE_DIR: evidence }
    });
    if (run.status !== 0) failures.push(`harness exited with status ${run.status}`);
  }
} else {
  process.stdout.write(
    "Mission Control browser harness gate passed; set ACS_UI_E2E=1 (with ACS_UI_EVIDENCE_DIR) to execute the harness\n"
  );
}

if (failures.length > 0) {
  process.stderr.write(`Mission Control E2E gate failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
