import { readFileSync, writeFileSync } from "node:fs";

function replaceExact(path, before, after) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`pattern not found in ${path}: ${before.slice(0, 120)}`);
  if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`pattern is not unique in ${path}`);
  writeFileSync(path, source.replace(before, after));
}

replaceExact(
  "packages/work-items/src/store.ts",
  `      const hasAttemptAuthority =
        parsed.attemptId !== undefined || parsed.leaseId !== undefined || parsed.workerId !== undefined || parsed.fencingEpoch !== undefined;
      if (hasAttemptAuthority) {`,
  `      const hasAttemptAuthority =
        parsed.attemptId !== undefined || parsed.leaseId !== undefined || parsed.workerId !== undefined || parsed.fencingEpoch !== undefined;
      const isLegacyAuthority =
        attemptId === parsed.workItemId && leaseId === parsed.workItemId && workerId === "legacy" && fencingEpoch === 0;
      if (hasAttemptAuthority && !isLegacyAuthority) {`
);

replaceExact(
  "packages/work-items/src/attempt.test.ts",
  `    const allocation = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );`,
  `    const allocation = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        fencingEpoch: lease.fencingEpoch,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );`
);
