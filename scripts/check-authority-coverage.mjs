import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const summaryPath = resolve("coverage/coverage-summary.json");
const detailPath = resolve("coverage/coverage-final.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const detail = JSON.parse(readFileSync(detailPath, "utf8"));

const authorityFiles = [
  ["packages/work-items/src/store.ts", { statements: 80, branches: 70, functions: 85, lines: 80 }],
  ["packages/work-items/src/work-item.ts", { statements: 80, branches: 55, functions: 70, lines: 80 }],
  ["packages/work-items/src/state-machine.ts", { statements: 80, branches: 90, functions: 65, lines: 80 }],
  ["packages/shared/src/migration.ts", { statements: 70, branches: 65, functions: 80, lines: 70 }],
  ["packages/policy-gate/src/tools.ts", { statements: 75, branches: 70, functions: 70, lines: 75 }],
  ["apps/gateway/src/server.ts", { statements: 80, branches: 75, functions: 90, lines: 80 }],
  ["apps/gateway/src/tools/execute-approved.ts", { statements: 80, branches: 70, functions: 80, lines: 80 }],
  ["apps/worker/src/index.ts", { statements: 70, branches: 55, functions: 90, lines: 70 }],
  ["packages/sandbox/src/index.ts", { statements: 90, branches: 80, functions: 90, lines: 90 }]
];

let failed = false;
for (const [suffix, thresholds] of authorityFiles) {
  const file = Object.keys(summary).find((candidate) => candidate.endsWith(`/${suffix}`));
  if (!file) {
    console.error(`authority coverage missing: ${suffix}`);
    failed = true;
    continue;
  }

  const metrics = summary[file];
  const values = Object.fromEntries(Object.keys(thresholds).map((metric) => [metric, metrics[metric].pct]));
  const failures = Object.entries(thresholds)
    .filter(([metric, threshold]) => values[metric] < threshold)
    .map(([metric, threshold]) => `${metric} ${values[metric]}% < ${threshold}%`);
  console.log(
    `${suffix}: ${Object.entries(values)
      .map(([metric, value]) => `${metric}=${value}%`)
      .join(" ")}`
  );
  if (failures.length > 0) {
    console.error(`  FAIL ${failures.join(", ")}`);
    failed = true;
  }

  const coverage = detail[file];
  const uncoveredBranches = [];
  if (coverage) {
    for (const [branchId, counts] of Object.entries(coverage.b)) {
      if (!counts.some((count) => count === 0)) continue;
      const mapping = coverage.branchMap[branchId];
      const locations = mapping?.locations ?? (mapping?.loc ? [mapping.loc] : []);
      for (const location of locations) {
        if (location && typeof location.start?.line === "number") {
          uncoveredBranches.push(`${location.start.line}:${location.start.column ?? 0}`);
        }
      }
    }
  }
  console.log(`  uncovered branches: ${uncoveredBranches.length ? uncoveredBranches.join(", ") : "none"}`);
}

if (failed) {
  process.exitCode = 1;
}
