import { runMissionAcceptance } from "../packages/mission-runtime/src/acceptance.ts";

const report = await runMissionAcceptance();
for (const check of report.checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}
console.log(`Verdict: ${report.verdict}`);
if (report.verdict !== "PASS") process.exitCode = 1;
