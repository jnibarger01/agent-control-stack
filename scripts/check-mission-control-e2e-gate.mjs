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

// 4b. The React app (/next/) has its own harness with the same obligations.
const webHarnessPath = path.join(root, "scripts", "verify-mission-control-web.mjs");
const webHarness = readFileSync(webHarnessPath, "utf8");
check(
  "web harness is wired into package scripts",
  typeof pkg.scripts?.["test:mission-control-web-e2e"] === "string",
  "missing scripts.test:mission-control-web-e2e"
);
for (const variable of ["ACS_UI_EVIDENCE_DIR", "ACS_PLAYWRIGHT_MODULE", "ACS_BROWSER_EXECUTABLE"]) {
  check(`web harness honours ${variable}`, webHarness.includes(variable));
}
check(
  "web harness closes the gateway exactly once",
  [...webHarness.matchAll(/await app\.close\(\)/gu)].length === 1 && /if \(appClosed\) return;/u.test(webHarness)
);
for (const [label, pattern] of [
  ["strict CSP", /strict CSP/u],
  ["live SSE refresh", /Live update: a new work item appears via SSE/u],
  ["fail-closed on invalid contract", /Schema-invalid response fails closed/u],
  ["unauthenticated access", /Unauthenticated: API rejects/u],
  ["stale state after stream loss", /Stream loss shows a stale banner/u],
  ["no sensitive data in the browser", /Sensitive data never reaches the browser/u],
  ["accessibility in both themes", /Accessible and no horizontal overflow/u],
  ["legacy console unaffected", /Legacy console at \/ is unaffected/u],
  ["server-enforced approve flow", /Approve through the UI: reason required, one POST, server state changes/u],
  ["read-only credential cannot act", /Read-only credential sees approvals but every control is disabled/u],
  ["deny flow", /Deny through the UI rejects the work item server-side/u],
  ["dismiss sends nothing", /Escape dismisses a confirmation without sending anything/u],
  ["all eleven destinations native", /All eleven destinations are native routes/u],
  ["audit, policy, metrics and system pages", /Metrics, Audit, Policy and System show real persisted data/u],
  ["audit pagination without duplicates", /Audit paginates older events without duplicating any/u],
  ["registry pages with honest status", /Agents, Executors and Connectors pages show real registry data with honest status/u],
  ["executor and connector network nodes", /Agent network includes executor and connector nodes without inventing edges/u],
  ["cookie session and cross-site write refusal", /Cookie-only session: the SPA works, same-origin writes pass, cross-site writes are refused/u]
]) {
  check(`web harness still covers ${label}`, pattern.test(webHarness));
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
    const webRun = spawnSync(process.execPath, [webHarnessPath], {
      stdio: "inherit",
      env: { ...process.env, ACS_UI_EVIDENCE_DIR: evidence }
    });
    if (webRun.status !== 0) failures.push(`web harness exited with status ${webRun.status}`);
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
