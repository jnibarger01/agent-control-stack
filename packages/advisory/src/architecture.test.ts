import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readTree(dir: string, filter = (p: string) => p.endsWith(".ts") && !p.endsWith(".test.ts")): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "dist" || name === "node_modules") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (filter(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function concatSource(rel: string): string {
  return readTree(join(repoRoot, rel))
    .map((f) => `\n/* ${f} */\n${readFileSync(f, "utf8")}`)
    .join("\n");
}

describe("ADR 0015 architecture boundaries (proof 15 + dependency direction)", () => {
  const advisorySrc = concatSource("packages/advisory/src");
  const evidenceSrc = concatSource("packages/evidence/src");
  const evidenceMcpSrc = concatSource("apps/evidence-mcp/src");

  it("packages/advisory and packages/evidence create NO second lifecycle / audit / result / db store", () => {
    for (const [name, src] of [
      ["advisory", advisorySrc],
      ["evidence", evidenceSrc]
    ] as const) {
      expect(src, `${name}: raw SQL DDL`).not.toMatch(/CREATE\s+TABLE/i);
      expect(src, `${name}: writes work_items/audit_events/results`).not.toMatch(
        /INSERT\s+INTO\s+(work_items|audit_events|execution_results|attempt_results)/i
      );
      expect(src, `${name}: opens its own SQLite db`).not.toMatch(/new\s+DatabaseSync|applyControlPlaneMigrations/);
      expect(src, `${name}: appends to the audit chain`).not.toMatch(/appendAuditEvent|createEvent\(/);
      expect(src, `${name}: transitions work items`).not.toMatch(/transitionWorkItem|submitWorkResult|approveWorkItem/);
    }
  });

  it("packages/advisory and packages/evidence do not import apps or the gateway/worker", () => {
    for (const [name, src] of [
      ["advisory", advisorySrc],
      ["evidence", evidenceSrc]
    ] as const) {
      expect(src, `${name}: imports apps`).not.toMatch(/from\s+["']\.\.\/\.\.\/apps/);
      expect(src, `${name}: imports gateway/worker/scheduler/runtime/cli`).not.toMatch(
        /@agent-control-stack\/(gateway|worker|scheduler|runtime|cli)/
      );
    }
  });

  it("apps/evidence-mcp performs no privileged / mutating ACS operation", () => {
    for (const forbidden of [
      /\.submitWorkResult\(/,
      /\.transition\(/,
      /\.approveWorkItem\(/,
      /\.recordApproval\(/,
      /\.admitExecutionPlan\(/,
      /\.grantExecutionPlanApproval\(/,
      /\.leaseAttempt\(/,
      /\.claimNextApprovedWorkItem\(/,
      /\.retryWorkItem\(|\.cloneWorkItem\(/,
      /\.recordEvidenceManifest\(|\.recordReviewFinding\(|\.recordVerificationDecision\(/,
      /INSERT\s+INTO/i,
      /CREATE\s+TABLE/i
    ]) {
      expect(evidenceMcpSrc, `evidence-mcp must not: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("migration 018 is append-only and does not touch the terminal result tables", () => {
    const sql = readFileSync(
      join(repoRoot, "storage/migrations/018_advisory_evidence_and_verification.sql"),
      "utf8"
    );
    // Every new table has a no-delete guard (append-only).
    for (const table of [
      "plan_proposals",
      "evidence_manifests",
      "review_findings",
      "reviewer_grants",
      "attempt_phases",
      "verification_requirements",
      "verification_decisions"
    ]) {
      expect(sql, `${table} append-only guard`).toMatch(
        new RegExp(`${table}[\\s\\S]*RAISE\\(ABORT, '${table}: (append-only|immutable|fixed|content-addressed)`, "m")
      );
    }
    // It never writes to the authoritative work-item / audit / result stores.
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(work_items|audit_events|execution_results|attempt_results)/i);
    expect(sql).not.toMatch(/CREATE\s+TABLE[\s\S]*execution_results/i);
    // It does not widen the execution_attempts immutable guard.
    expect(sql).not.toMatch(/execution_attempts_immutable_guard/i);
    expect(sql).not.toMatch(/ALTER TABLE execution_attempts/i);
  });

  it("the migration registry includes exactly one new version (18) for this change", () => {
    const reg = readFileSync(join(repoRoot, "packages/shared/src/migration.ts"), "utf8");
    expect(reg).toMatch(/version:\s*18,\s*\n\s*name:\s*"advisory_evidence_and_verification"/);
    expect(reg).not.toMatch(/version:\s*19/);
  });
});
