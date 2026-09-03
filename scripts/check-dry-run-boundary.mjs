import { readFileSync } from "node:fs";

const workerSource = readFileSync("apps/worker/src/index.ts", "utf8");
const workerBundle = readFileSync("apps/worker/dist/index.js", "utf8");
const sandboxSource = readFileSync("packages/sandbox/src/index.ts", "utf8");

const failures = [];
if (!workerSource.includes("assertDryRunExecutionMode(result.executionMode)")) {
  failures.push("worker does not assert the sandbox execution mode before recording a result");
}
if (!workerSource.includes('nodeEnv === "production"')) {
  failures.push("worker production dry-run assertion is missing");
}
if (!sandboxSource.includes('executionMode: "dry_run"')) {
  failures.push("sandbox dry-run implementation no longer declares dry_run mode");
}
if (!workerBundle.includes("dry_run")) {
  failures.push("built worker bundle does not contain the dry-run execution marker");
}
if (/executionMode\s*:\s*["']live["']/.test(workerBundle)) {
  failures.push("built worker bundle contains a live execution mode");
}

if (failures.length > 0) {
  console.error("Dry-run release gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Dry-run release gate passed: production worker output is locked to dry_run mode.");
