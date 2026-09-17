import { readFileSync } from "node:fs";

const workerSource = readFileSync("apps/worker/src/index.ts", "utf8");
const workerBundle = readFileSync("apps/worker/dist/index.js", "utf8");
const sandboxSource = readFileSync("packages/sandbox/src/index.ts", "utf8");
const backendSource = readFileSync("packages/work-items/src/execution-backend.ts", "utf8");
const workItemSource = readFileSync("packages/work-items/src/work-item.ts", "utf8");

const failures = [];

// --- The default execution backend is dry_run, chosen by explicit config ------
if (!workerSource.includes("resolveExecutionBackend()")) {
  failures.push("worker does not resolve the execution backend from explicit configuration");
}
if (!backendSource.includes('DEFAULT_EXECUTION_BACKEND: ExecutionBackend = "dry_run"')) {
  failures.push("execution backend default is no longer dry_run");
}
if (!/raw === undefined \|\| raw === "" \|\| raw === "dry_run"[\s\S]*return "dry_run";/.test(backendSource)) {
  failures.push("resolveExecutionBackend no longer falls back to dry_run for an unset ACS_EXECUTION_BACKEND");
}
if (!/if \(raw === "desktop_commander"\) \{\s*return "desktop_commander";/.test(backendSource)) {
  failures.push("desktop_commander backend is reachable without an explicit ACS_EXECUTION_BACKEND=desktop_commander");
}
if (!backendSource.includes('"execution_backend_invalid"')) {
  failures.push("resolveExecutionBackend no longer fails closed on an unknown backend value");
}

// --- The worker guards every result's execution mode against its backend ------
if (!workerSource.includes("assertExecutionModeForBackend(result.executionMode, executionBackend)")) {
  failures.push("worker does not assert the result execution mode against the configured backend");
}
if (!workerSource.includes('nodeEnv === "production"')) {
  failures.push("worker production dry-run assertion is missing");
}
if (!workerSource.includes("production worker requires dry_run execution mode")) {
  failures.push("worker production dry-run error message is missing");
}

// --- A non-simulated result is only representable for desktop_commander -------
if (!workItemSource.includes('z.discriminatedUnion("executionMode"')) {
  failures.push("simulation metadata is no longer a discriminated union keyed on executionMode");
}
if (
  !/executionMode: z\.literal\("desktop_commander"\),\s*simulated: z\.literal\(false\),\s*backend: z\.literal\("desktop-commander-mcp"\)/.test(
    workItemSource
  )
) {
  failures.push("a non-simulated (simulated:false) result is representable for a mode other than desktop_commander");
}
if (!sandboxSource.includes('executionMode: "dry_run"')) {
  failures.push("sandbox dry-run implementation no longer declares dry_run mode");
}

// --- Built bundle invariants -------------------------------------------------
if (!workerBundle.includes("dry_run")) {
  failures.push("built worker bundle does not contain the dry-run execution marker");
}
if (/executionMode\s*:\s*["']live["']/.test(workerBundle)) {
  failures.push("built worker bundle contains a live execution mode");
}
if (workerBundle.includes("desktop_commander") && !workerBundle.includes("assertExecutionModeForBackend")) {
  failures.push("built worker bundle references desktop_commander without the backend execution-mode guard");
}

if (failures.length > 0) {
  console.error("Dry-run release gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Dry-run release gate passed: the worker defaults to dry_run, only enters real execution on explicit ACS_EXECUTION_BACKEND=desktop_commander, guards every result's execution mode, and never emits a live mode."
);
