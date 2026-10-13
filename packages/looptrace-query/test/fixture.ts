/**
 * SYNTHETIC TEST FIXTURES. Everything built here is fabricated for tests and is never
 * served by the product code. A real, migrated ACS schema is created by the real
 * SqliteWorkItemStore (so schema drift fails these tests); additional rows are inserted with
 * a raw connection so scenarios (crash, tamper, contradiction) can be staged deterministically.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildEvidenceManifest } from "@agent-control-stack/evidence";
import { auditEventHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const T0 = Date.parse("2026-10-12T10:00:00.000Z");
export const at = (offsetSec: number): string => new Date(T0 + offsetSec * 1000).toISOString();

export interface Fixture {
  dir: string;
  dbPath: string;
  create(overrides?: { requester?: string; requesterSubject?: string }): string;
  db(): DatabaseSync;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "looptrace-query-"));
  const dbPath = join(dir, "control.db");
  // Real store => real, current schema + real audit/trace rows for create().
  const store = new SqliteWorkItemStore(dbPath, { traceInstance: "fixture-acs", releaseSha: "a".repeat(40) });
  const ids: string[] = [];
  return {
    dir,
    dbPath,
    create(overrides = {}) {
      const item = store.create({
        title: "fixture work item",
        requester: overrides.requester ?? "agent",
        ...(overrides.requesterSubject ? { requesterSubject: overrides.requesterSubject } : {}),
        intent: "synthetic fixture",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "fixture" }],
        risk: "medium"
      } as never);
      ids.push(item.id);
      return item.id;
    },
    db() {
      store.close();
      return new DatabaseSync(dbPath);
    },
    cleanup() {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function appendAudit(db: DatabaseSync, name: string, attrs: Record<string, unknown>, ts: string): void {
  const last = db.prepare("SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as { event_hash: string } | undefined;
  const previousHash = last?.event_hash ?? "";
  const id = `aud_${randomBytes(6).toString("hex")}`;
  const timeUnixNano = (BigInt(Date.parse(ts)) * 1_000_000n).toString();
  const body = {};
  db.prepare("INSERT INTO audit_events (id, name, time_unix_nano, attributes, body, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, '')").run(
    id,
    name,
    timeUnixNano,
    JSON.stringify(attrs),
    JSON.stringify(body),
    previousHash
  );
  const row = db.prepare("SELECT sequence FROM audit_events WHERE id = ?").get(id) as { sequence: number };
  const eventHash = auditEventHash({ sequence: row.sequence, id, name, timeUnixNano, attributes: attrs, body, previousHash } as never);
  db.prepare("UPDATE audit_events SET event_hash = ? WHERE id = ?").run(eventHash, id);
}

export interface ScenarioOptions {
  status?: string;
  requiresApproval?: boolean;
  approval?: "granted" | "consumed" | "invalidated" | "expired" | "none";
  approvalAudit?: boolean;
  /** Approval expiry relative to lease issuance, seconds (negative => expired before the lease). */
  approvalExpiresOffset?: number;
  policy?: "allow" | "deny" | "require_approval" | null;
  result?: "succeeded" | "failed" | null;
  simulated?: boolean;
  validation?: "passed" | "failed" | null;
  manifest?: "valid" | "tampered" | null;
  verification?: "attempt_accepted" | "attempt_rejected" | null;
  verificationRequired?: boolean;
  tool?: "ok" | "failed" | "started_only" | "outcome_only" | null;
  attemptStatus?: string;
  leaseStatus?: string;
  leaseExpiresOffset?: number;
  assignedWorker?: string | null;
  leaseWorker?: string;
  resultSummary?: string;
}

export interface ScenarioIds {
  workItemId: string;
  planId: string;
  attemptId: string;
  leaseId: string;
  approvalId: string;
  manifestHash: string | null;
}

/** Stages a (fully synthetic) execution for an existing work item. Defaults = a complete, independently verified success. */
export function seedScenario(db: DatabaseSync, workItemId: string, o: ScenarioOptions = {}): ScenarioIds {
  const opt = {
    status: "succeeded",
    requiresApproval: true,
    approval: "consumed" as const,
    approvalAudit: true,
    approvalExpiresOffset: 3600,
    policy: o.requiresApproval === false ? ("allow" as const) : ("require_approval" as const),
    result: "succeeded" as const,
    simulated: false,
    validation: "passed" as const,
    manifest: "valid" as const,
    verification: "attempt_accepted" as const,
    verificationRequired: true,
    tool: "ok" as const,
    attemptStatus: "succeeded",
    leaseStatus: "consumed",
    leaseExpiresOffset: 600,
    assignedWorker: "worker-1",
    leaseWorker: "worker-1",
    resultSummary: "done",
    ...o
  };
  // ACS's real write guards (triggers) correctly forbid most of the states staged here (expired approval at lease
  // time, terminal attempt without a lease epoch, tampered audit rows...). Those are exactly the states a DETECTIVE
  // tool must recognise, so the synthetic fixture database disables the guards before staging them.
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) {
    db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
  }
  const planId = `plan_${workItemId}`;
  const attemptId = `att_${workItemId}`;
  const leaseId = `lease_${workItemId}`;
  const approvalId = `apr_${workItemId}`;
  const planHash = sha(`plan:${workItemId}`);
  const actionHash = sha(`action:${workItemId}`);
  const requestHash = sha(`request:${workItemId}`);
  const inputHash = sha(`input:${workItemId}`);
  const decisionHash = sha(`decision:${workItemId}`);
  const admissionId = `adm_${workItemId}`;
  const run = (sql: string, ...p: Array<string | number | null>): void => void db.prepare(sql).run(...p);

  run(
    "INSERT INTO execution_plans (plan_id, work_item_id, plan_number, schema_version, definition_json, plan_hash, subject_input_hash, created_by_actor_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    planId, workItemId, 1, "acs.execution-plan.v1", "{}", planHash, inputHash, "planner", at(1)
  );
  if (opt.policy) {
    appendAudit(db, "policy.decided", { "work_item.id": workItemId, "policy.decision": opt.policy, "policy.decision_hash": decisionHash, "policy.version": "p1" }, at(2));
  }
  run(
    "INSERT INTO execution_plan_admissions (admission_id, work_item_id, plan_id, plan_hash, policy_version, policy_decision_hash, requires_approval, admitted_by_actor_id, admitted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    admissionId, workItemId, planId, planHash, "p1", decisionHash, opt.requiresApproval ? 1 : 0, "acs", at(3)
  );
  if (opt.approval !== "none") {
    run(
      "INSERT INTO execution_plan_approvals (approval_id, work_item_id, plan_id, plan_hash, action_hash, request_hash, approved_by_actor_id, reason, status, created_at, expires_at, consumed_at, invalidated_at, invalidation_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      approvalId, workItemId, planId, planHash, actionHash, requestHash, "human-1", "looks fine", opt.approval, at(4),
      at(10 + opt.approvalExpiresOffset), opt.approval === "consumed" ? at(11) : null, opt.approval === "invalidated" ? at(12) : null, opt.approval === "invalidated" ? "revoked" : null
    );
    if (opt.approvalAudit) appendAudit(db, "approval.granted", { "work_item.id": workItemId, "approval.id": approvalId, "action.hash": actionHash }, at(5));
  }
  run(
    "INSERT INTO execution_attempts (attempt_id, work_item_id, plan_id, plan_hash, attempt_number, protocol_version, input_hash, status, current_fencing_epoch, claimed_by_worker_id, started_at, terminal_at, outcome_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    attemptId, workItemId, planId, planHash, 1, "acs.worker.v2", inputHash, "pending", 0, null, null, null, null, at(9), at(9)
  );
  // Triggers force attempts to start pending; the staged final state is applied afterwards.
  run(
    "UPDATE execution_attempts SET status = ?, current_fencing_epoch = 1, claimed_by_worker_id = ?, started_at = ?, terminal_at = ?, updated_at = ? WHERE attempt_id = ?",
    opt.attemptStatus, opt.leaseWorker, at(10), ["succeeded", "failed", "cancelled"].includes(opt.attemptStatus) ? at(40) : null, at(40), attemptId
  );
  run(
    "INSERT INTO attempt_leases (lease_id, attempt_id, work_item_id, admission_id, approval_id, worker_id, token_hash, plan_hash, input_hash, fencing_epoch, protocol_version, policy_version, policy_decision_hash, issued_at, expires_at, max_expires_at, last_renewed_at, status, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    leaseId, attemptId, workItemId, admissionId, opt.approval !== "none" ? approvalId : null, opt.leaseWorker, sha("tok"), planHash, inputHash, 1,
    "acs.worker.v2", "p1", decisionHash, at(10), at(10 + opt.leaseExpiresOffset), at(10 + Math.max(opt.leaseExpiresOffset, 1) + 1), at(10),
    opt.leaseStatus, opt.leaseStatus === "active" ? null : at(40)
  );
  if (opt.assignedWorker) {
    run(
      "INSERT INTO work_item_assignments (work_item_id, selected_worker_id, selected_agent_id, routing_decision_id, assigned_by_actor_id, assigned_at) VALUES (?,?,?,?,?,?)",
      workItemId, opt.assignedWorker, null, null, "router", at(2)
    );
  }
  appendAudit(db, "execution.started", { "work_item.id": workItemId, "attempt.id": attemptId, "lease.id": leaseId }, at(12));
  if (opt.tool && opt.tool !== "outcome_only") appendAudit(db, "desktop_commander.tool_called", { "work_item.id": workItemId, "attempt.id": attemptId, "desktop_commander.tool": "read_file" }, at(13));
  if (opt.tool === "ok" || opt.tool === "outcome_only") appendAudit(db, "desktop_commander.tool_succeeded", { "work_item.id": workItemId, "attempt.id": attemptId, "desktop_commander.tool": "read_file" }, at(14));
  if (opt.tool === "failed") appendAudit(db, "desktop_commander.tool_failed", { "work_item.id": workItemId, "attempt.id": attemptId, "desktop_commander.tool": "read_file" }, at(14));

  if (opt.result) {
    const sim = opt.simulated
      ? '{"executionMode":"dry_run","simulated":true}'
      : '{"executionMode":"desktop_commander","simulated":false,"backend":"desktop-commander-mcp"}';
    run(
      "INSERT INTO attempt_results (result_id, attempt_id, work_item_id, lease_id, worker_id, fencing_epoch, protocol_version, idempotency_key, plan_hash, input_hash, outcome, outcome_certainty, started_at, finished_at, exit_code, summary, stdout, stderr, structured_output_json, error, resource_usage_json, simulation_metadata_json, payload_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `res_${workItemId}`, attemptId, workItemId, leaseId, opt.leaseWorker, 1, "acs.worker.v2", `idem_${workItemId}`, planHash, inputHash,
      opt.result, "observed", at(12), at(30), opt.result === "succeeded" ? 0 : 1, opt.resultSummary, null, null, "{}", null, null, sim, sha("payload"), at(31)
    );
  }
  if (opt.validation) {
    run("INSERT INTO validation_runs (run_id, attempt_id, work_item_id, passed, idempotency_key, created_at) VALUES (?,?,?,?,?,?)", `vr_${workItemId}`, attemptId, workItemId, opt.validation === "passed" ? 1 : 0, `vk_${workItemId}`, at(32));
    run("INSERT INTO validation_checks (check_id, run_id, name, passed, detail) VALUES (?,?,?,?,?)", `vc_${workItemId}`, `vr_${workItemId}`, "tests", opt.validation === "passed" ? 1 : 0, "ok");
  }
  let manifestHash: string | null = null;
  if (opt.manifest) {
    const m = buildEvidenceManifest({
      attemptId, workItemId, admittedPlanHash: planHash, planHash, actionHash,
      baseWorkspaceRevision: sha("base"), resultWorkspaceRevision: sha("res"), changedPaths: ["a.ts"], diffHash: sha("diff"),
      commands: [], testEvidence: { passed: true, checksPassed: 1, checksFailed: 0 }, sandboxProfile: "desktop_commander",
      networkProfile: "none", networkDecisions: { allowed: 0, denied: 0 }, observations: [], workerId: opt.leaseWorker,
      startedAt: at(12), finishedAt: at(30)
    } as never);
    manifestHash = m.manifestHash;
    const stored = opt.manifest === "tampered" ? { ...m, diffHash: sha("evil") } : m;
    run(
      "INSERT INTO evidence_manifests (manifest_hash, attempt_id, work_item_id, admitted_plan_hash, plan_hash, action_hash, base_workspace_revision, result_workspace_revision, manifest_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      m.manifestHash, attemptId, workItemId, planHash, planHash, actionHash, sha("base"), sha("res"), JSON.stringify(stored), at(33)
    );
  }
  if (opt.verificationRequired) {
    run("INSERT INTO verification_requirements (attempt_id, work_item_id, policy_version, reviewers_required, requirement_json, recorded_at) VALUES (?,?,?,?,?,?)", attemptId, workItemId, "v1", 1, "{}", at(34));
  }
  if (opt.verification && manifestHash) {
    run("INSERT INTO verification_decisions (attempt_id, work_item_id, outcome, evidence_manifest_hash, review_finding_hashes_json, verification_policy_version, decided_at) VALUES (?,?,?,?,?,?,?)", attemptId, workItemId, opt.verification, manifestHash, "[]", "v1", at(35));
  }
  run("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?", opt.status, at(40), workItemId);
  return { workItemId, planId, attemptId, leaseId, approvalId, manifestHash };
}
