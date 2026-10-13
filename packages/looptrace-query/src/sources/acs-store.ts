import { DatabaseSync } from "node:sqlite";
import { verifyEvidenceManifestHash, type EvidenceManifest } from "@agent-control-stack/evidence";
import { auditEventHash } from "@agent-control-stack/shared";
import {
  CANONICAL_TRACE_GENESIS_HASH,
  canonicalTraceEventHash,
  canonicalTracePayloadHash,
  type CanonicalTraceEvent
} from "@agent-control-stack/work-items";
import {
  EVIDENCE_SCHEMA_VERSION,
  contentHash,
  evidenceEventSchema,
  eventId,
  normalizeTimestamp,
  nanosToIso,
  stageOf,
  type EvidenceEvent,
  type EventType,
  type Trust
} from "../model.js";
import { sanitizeUntrusted } from "../sanitize.js";
import { LIMITS, type Lookup } from "../types.js";
import type { WorkItemRef } from "../authz.js";

/** Mirrors TRACE_CHAIN_PRODUCER_KEY in packages/work-items/src/trace-outbox.ts (not re-exported from the package). */
const TRACE_CHAIN_PRODUCER_KEY = "acs";

type Row = Record<string, unknown>;
type Fact = string | number | boolean | null;

const str = (r: Row, k: string): string | null => {
  const v = r[k];
  return typeof v === "string" && v.length > 0 ? v : null;
};
const num = (r: Row, k: string): number | null => {
  const v = r[k];
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null;
};
const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Source-namespaced id that always satisfies the event-id contract. */
export function safeId(table: string, native: string): string {
  const cleaned = native.replace(/[^A-Za-z0-9._:/@+-]/gu, "_").slice(0, 100);
  const suffix = cleaned === native ? "" : `@${contentHash(native).slice(0, 8)}`;
  return eventId("acs", `${table}.${cleaned || "_"}${suffix}`);
}

interface Draft {
  type: EventType;
  table: string;
  nativeId: string;
  ts: string | null;
  trust: Trust;
  basis: string;
  actor?: { id: string; type: "human" | "agent" | "system" | "service" | "unknown" } | null;
  status?: string | null;
  decision?: string | null;
  tool?: string | null;
  capability?: string | null;
  facts?: Record<string, Fact>;
  refs?: Record<string, string | null>;
  causes?: Array<string | null>;
  untrusted?: Record<string, unknown>;
  hashVerified?: boolean | null;
  chain?: "verified" | "link_verified" | "broken" | "not_chained";
  flags?: string[];
  raw: unknown;
}

export interface AcsCollectResult {
  events: EvidenceEvent[];
  notes: string[];
  missingTables: string[];
  rejected: number;
}

/**
 * Read-only adapter over the authoritative ACS control-plane database.
 *
 * Safety properties (asserted by tests):
 *  - opened `readOnly: true` plus `PRAGMA query_only = ON`; it never migrates (unlike
 *    SqliteWorkItemStore) and never runs anything but SELECT / PRAGMA query_only|busy_timeout.
 *  - caller input is only ever bound as a parameter; no caller-selected paths or SQL.
 *  - every query is LIMIT-bounded.
 */
export class AcsReadStore {
  private readonly db: DatabaseSync;
  private readonly missing = new Set<string>();

  constructor(
    readonly dbPath: string,
    private readonly now: () => Date
  ) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.db.exec("PRAGMA query_only = ON");
    this.db.exec("PRAGMA busy_timeout = 1500");
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: Array<string | number>): Row[] {
    try {
      return this.db.prepare(sql).all(...params) as Row[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const m = /no such table: (\w+)/u.exec(message);
      if (m?.[1]) {
        this.missing.add(m[1]);
        return [];
      }
      if (/no such column/u.test(message)) {
        this.missing.add(`column:${message.slice(0, 60)}`);
        return [];
      }
      throw error;
    }
  }

  private one(sql: string, ...params: Array<string | number>): Row | null {
    return this.all(sql, ...params)[0] ?? null;
  }

  /** Head-anchor probe: a missing table/column means "no anchor available", not a missing evidence table. */
  private probe(sql: string, ...params: Array<string | number>): Row | null {
    try {
      return (this.db.prepare(sql).get(...params) as Row | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Completeness of the GLOBAL audit chain. Per-row hash/link checks cannot see rows deleted from the tail, so the
   * observed tail is compared with the high-water mark SQLite itself keeps for the AUTOINCREMENT `sequence` column
   * (`sqlite_sequence`). That counter is maintained by the engine on insert and is never lowered by DELETE, so a
   * truncated tail leaves max(sequence) below it. With no such counter the tail is reported as unproven, never as
   * complete. (A writer able to edit sqlite_sequence too can still forge it; that is reported in the docs.)
   */
  private auditHead(): { truncated: boolean; unproven: boolean; head: number | null } {
    const hw = this.probe("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'");
    const tail = this.probe("SELECT MAX(sequence) AS m, COUNT(*) AS c FROM audit_events");
    const head = hw && typeof hw.seq === "number" ? hw.seq : null;
    const max = tail && typeof tail.m === "number" ? tail.m : null;
    if (head === null) return { truncated: false, unproven: max !== null, head: null };
    if (max === null) return { truncated: head > 0, unproven: false, head };
    return { truncated: max !== head, unproven: false, head };
  }

  /**
   * Completeness of the trace projection chain, against the producer's stored chain head (`trace_chain_state`,
   * written in the same transaction as each appended outbox row): the newest outbox row must sit at the stored seq
   * and hash to the stored head hash.
   */
  private traceHead(): { truncated: boolean; unproven: boolean } {
    const st = this.probe("SELECT seq, head_hash FROM trace_chain_state WHERE producer_key = ?", TRACE_CHAIN_PRODUCER_KEY);
    const last = this.probe("SELECT seq, canonical_json FROM trace_outbox ORDER BY seq DESC LIMIT 1");
    if (!st || typeof st.seq !== "number") return { truncated: false, unproven: last !== null };
    if (!last) return { truncated: st.seq > 0, unproven: false };
    if (last.seq !== st.seq) return { truncated: true, unproven: false };
    try {
      const ev = parseJson(last.canonical_json) as CanonicalTraceEvent | null;
      return { truncated: !ev || canonicalTraceEventHash(ev) !== st.head_hash, unproven: false };
    } catch {
      return { truncated: true, unproven: false };
    }
  }

  // ---------------------------------------------------------------- resolve

  /** Maps caller identifiers to work item ids. Does not apply authorization. */
  resolve(lookup: Lookup): { ids: string[]; matchedBy: string[] } {
    const sets: Array<{ by: string; ids: Set<string> }> = [];
    if (lookup.work_item_id) {
      const r = this.one("SELECT id FROM work_items WHERE id = ? LIMIT 1", lookup.work_item_id);
      sets.push({ by: "work_item_id", ids: new Set(r ? [String(r.id)] : []) });
    }
    if (lookup.trace_id) {
      const rows = this.all(
        "SELECT work_item_id FROM trace_missions WHERE trace_id = ? LIMIT ?",
        lookup.trace_id,
        LIMITS.maxWorkItemsPerQuery + 1
      );
      sets.push({ by: "trace_id", ids: new Set(rows.map((r) => String(r.work_item_id))) });
    }
    if (lookup.execution_id) {
      const ids = new Set<string>();
      const a = this.all("SELECT work_item_id FROM execution_attempts WHERE attempt_id = ? LIMIT 2", lookup.execution_id);
      const l = this.all("SELECT work_item_id FROM attempt_leases WHERE lease_id = ? LIMIT 2", lookup.execution_id);
      const res = this.all("SELECT work_item_id FROM attempt_results WHERE result_id = ? LIMIT 2", lookup.execution_id);
      for (const r of [...a, ...l, ...res]) ids.add(String(r.work_item_id));
      sets.push({ by: "execution_id", ids });
    }
    if (lookup.request_id) {
      // A request id is the work item id itself, a metadata-declared request id,
      // or a 64-hex request hash recorded on approvals / capability issuances.
      const ids = new Set<string>();
      for (const r of this.all("SELECT id FROM work_items WHERE id = ? LIMIT 3", lookup.request_id)) ids.add(String(r.id));
      for (const r of this.all(
        "SELECT id FROM work_items WHERE json_extract(metadata_json, '$.requestId') = ? OR json_extract(metadata_json, '$.request_id') = ? LIMIT 5",
        lookup.request_id,
        lookup.request_id
      ))
        ids.add(String(r.id));
      if (/^[a-f0-9]{64}$/u.test(lookup.request_id)) {
        for (const t of [
          "execution_plan_approvals",
          "approval_records",
          "jace_commander_capability_issuances",
          "desktop_commander_capability_issuances"
        ]) {
          for (const r of this.all(`SELECT DISTINCT work_item_id FROM ${t} WHERE request_hash = ? LIMIT 5`, lookup.request_id))
            ids.add(String(r.work_item_id));
        }
      }
      sets.push({ by: "request_id", ids });
    }
    if (sets.length === 0) return { ids: [], matchedBy: [] };
    // Multiple identifiers are INTERSECTED: they must agree, otherwise nothing matches.
    let acc = sets[0]!.ids;
    for (const s of sets.slice(1)) acc = new Set([...acc].filter((id) => s.ids.has(id)));
    return { ids: [...acc].sort(), matchedBy: sets.map((s) => s.by) };
  }

  workItemRef(id: string): WorkItemRef | null {
    const w = this.one(
      "SELECT id, root_work_item_id, requester_subject, worker_id FROM work_items WHERE id = ? LIMIT 1",
      id
    );
    if (!w) return null;
    const assigned = new Set<string>();
    if (str(w, "worker_id")) assigned.add(str(w, "worker_id")!);
    const a = this.one("SELECT selected_worker_id, selected_agent_id FROM work_item_assignments WHERE work_item_id = ?", id);
    if (a) {
      if (str(a, "selected_worker_id")) assigned.add(str(a, "selected_worker_id")!);
      if (str(a, "selected_agent_id")) assigned.add(str(a, "selected_agent_id")!);
    }
    for (const r of this.all("SELECT DISTINCT worker_id FROM attempt_leases WHERE work_item_id = ? LIMIT 20", id)) {
      if (str(r, "worker_id")) assigned.add(str(r, "worker_id")!);
    }
    return {
      id: String(w.id),
      root_work_item_id: str(w, "root_work_item_id"),
      requester_subject: str(w, "requester_subject"),
      assigned: [...assigned]
    };
  }

  // ---------------------------------------------------------------- collect

  collect(workItemId: string): AcsCollectResult {
    this.missing.clear();
    const observedAt = this.now().toISOString();
    const drafts: Draft[] = [];
    const notes: string[] = [];

    const w = this.one("SELECT * FROM work_items WHERE id = ? LIMIT 1", workItemId);
    if (!w) return { events: [], notes: ["work item not found"], missingTables: [], rejected: 0 };

    const traceRow = this.one("SELECT trace_id FROM trace_missions WHERE work_item_id = ?", workItemId);
    const traceId = traceRow ? str(traceRow, "trace_id") : null;
    const requestId = (() => {
      const meta = obj(parseJson(w.metadata_json));
      const v = meta.requestId ?? meta.request_id;
      return typeof v === "string" && v.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(v) ? v : null;
    })();

    // ---- request + current state
    const requester = str(w, "requester_subject") ?? str(w, "requester");
    drafts.push({
      type: "request.received",
      table: "work_items",
      nativeId: workItemId,
      ts: normalizeTimestamp(w.created_at),
      trust: "authoritative",
      basis: "acs_work_item_row",
      actor: requester ? { id: requester.slice(0, 160), type: "unknown" } : null,
      status: "created",
      facts: {
        risk: str(w, "risk"),
        lineage_type: str(w, "lineage_type"),
        source_work_item_id: str(w, "source_work_item_id"),
        root_work_item_id: str(w, "root_work_item_id")
      },
      untrusted: { title: String(w.title ?? "").slice(0, 2000), intent: String(w.intent ?? "").slice(0, 2000) },
      raw: { id: w.id, created_at: w.created_at, requester: w.requester, risk: w.risk }
    });
    const status = str(w, "status") ?? "unknown";

    // ---- audit events (hash chain verified per row)
    const auditRows = this.all(
      `SELECT sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash
         FROM audit_events
        WHERE json_extract(attributes, '$."work_item.id"') = ?
        ORDER BY sequence ASC LIMIT ?`,
      workItemId,
      LIMITS.maxEventsPerWorkItem
    );
    const auditIdsByApproval = new Set<string>();
    let auditBroken = 0;
    let unmappedAudit = 0;
    for (const row of auditRows) {
      const attrs = obj(parseJson(row.attributes));
      const body = parseJson(row.body);
      const seq = num(row, "sequence") ?? -1;
      const name = String(row.name);
      const recomputed = (() => {
        try {
          return auditEventHash({
            sequence: seq,
            id: String(row.id),
            name,
            timeUnixNano: String(row.time_unix_nano),
            attributes: attrs as never,
            body: body as never,
            previousHash: String(row.previous_hash)
          } as never);
        } catch {
          return null;
        }
      })();
      const selfOk = recomputed !== null && recomputed === row.event_hash;
      const pred = this.one("SELECT event_hash FROM audit_events WHERE sequence < ? ORDER BY sequence DESC LIMIT 1", seq);
      const linkOk = pred ? pred.event_hash === row.previous_hash : row.previous_hash === "";
      const chain: Draft["chain"] = selfOk && linkOk ? "link_verified" : "broken";
      if (chain === "broken") auditBroken += 1;
      const approvalId = strAttr(attrs, "approval.id");
      if (approvalId) auditIdsByApproval.add(approvalId);

      const mapped = mapAuditName(name, attrs);
      if (!mapped) {
        unmappedAudit += 1;
        continue;
      }
      drafts.push({
        type: mapped.type,
        table: "audit_events",
        nativeId: String(row.id),
        ts: nanosToIso(row.time_unix_nano),
        trust: mapped.trust,
        basis: mapped.basis,
        status: mapped.status ?? null,
        decision: mapped.type === "policy.decided" ? strAttr(attrs, "policy.decision") : mapped.decision ?? null,
        tool: mapped.tool ? strAttr(attrs, mapped.tool) : null,
        capability: strAttr(attrs, "capability.id"),
        hashVerified: selfOk,
        chain,
        facts: {
          audit_sequence: seq,
          audit_name: name.slice(0, 120),
          execution_mode: strAttr(attrs, "execution.mode"),
          policy_decision_hash: strAttr(attrs, "policy.decision_hash"),
          policy_version: strAttr(attrs, "policy.version")
        },
        refs: {
          attempt_id: strAttr(attrs, "attempt.id"),
          lease_id: strAttr(attrs, "lease.id"),
          approval_id: approvalId,
          worker_id: strAttr(attrs, "worker.id")
        },
        untrusted: mapped.untrusted ? { attributes: sanitizeUntrusted(attrs).value } : {},
        raw: { sequence: seq, id: row.id, name, hash: row.event_hash }
      });
    }
    if (unmappedAudit > 0) notes.push(`${unmappedAudit} audit events had names with no evidence mapping`);

    // ---- routing
    for (const r of this.all("SELECT * FROM actor_routing_decisions WHERE work_item_id = ? ORDER BY created_at LIMIT 50", workItemId)) {
      drafts.push({
        type: "route.decided",
        table: "actor_routing_decisions",
        nativeId: String(r.decision_id),
        ts: normalizeTimestamp(r.created_at),
        trust: "authoritative",
        basis: "acs_routing_decision",
        decision: str(r, "selected_actor_id") ? "selected" : "none_selected",
        facts: { selected_actor_id: str(r, "selected_actor_id"), attempt_scoped: str(r, "attempt_id") !== null },
        refs: { attempt_id: str(r, "attempt_id"), actor_id: str(r, "selected_actor_id") },
        raw: { id: r.decision_id, sel: r.selected_actor_id, at: r.created_at }
      });
    }
    const assign = this.one("SELECT * FROM work_item_assignments WHERE work_item_id = ?", workItemId);
    if (assign) {
      drafts.push({
        type: "route.decided",
        table: "work_item_assignments",
        nativeId: workItemId,
        ts: normalizeTimestamp(assign.assigned_at),
        trust: "authoritative",
        basis: "acs_assignment_row",
        decision: "assigned",
        actor: { id: String(assign.assigned_by_actor_id).slice(0, 160), type: "unknown" },
        facts: { selected_worker_id: str(assign, "selected_worker_id"), selected_agent_id: str(assign, "selected_agent_id") },
        refs: { worker_id: str(assign, "selected_worker_id"), actor_id: str(assign, "selected_agent_id") },
        raw: { w: assign.selected_worker_id, a: assign.selected_agent_id, at: assign.assigned_at }
      });
    }

    // ---- admissions (policy binding for the plan)
    for (const r of this.all("SELECT * FROM execution_plan_admissions WHERE work_item_id = ? ORDER BY admitted_at LIMIT 50", workItemId)) {
      drafts.push({
        type: "dispatch.admitted",
        table: "execution_plan_admissions",
        nativeId: String(r.admission_id),
        ts: normalizeTimestamp(r.admitted_at),
        trust: "authoritative",
        basis: "acs_plan_admission",
        decision: num(r, "requires_approval") === 1 ? "requires_approval" : "no_approval_required",
        facts: {
          requires_approval: num(r, "requires_approval") === 1,
          policy_version: str(r, "policy_version"),
          policy_decision_hash: str(r, "policy_decision_hash"),
          plan_hash: str(r, "plan_hash")
        },
        refs: { plan_id: str(r, "plan_id"), admission_id: str(r, "admission_id") },
        raw: r
      });
    }

    // ---- approvals (plan-bound and legacy per-action)
    for (const r of this.all("SELECT * FROM execution_plan_approvals WHERE work_item_id = ? ORDER BY created_at LIMIT 50", workItemId)) {
      const id = String(r.approval_id);
      drafts.push(approvalDraft("execution_plan_approvals", id, r, str(r, "status") ?? "unknown", auditIdsByApproval.has(id)));
    }
    for (const r of this.all("SELECT * FROM approval_records WHERE work_item_id = ? ORDER BY created_at LIMIT 50", workItemId)) {
      const id = `${workItemId}:${String(r.action_hash)}`;
      drafts.push(
        approvalDraft("approval_records", id, { ...r, approved_by_actor_id: r.approved_by }, str(r, "status") ?? "unknown", auditIdsByApproval.has(id), true)
      );
    }

    // ---- attempts, leases, capabilities
    for (const r of this.all("SELECT * FROM execution_attempts WHERE work_item_id = ? ORDER BY attempt_number LIMIT 50", workItemId)) {
      drafts.push({
        type: "dispatch.attempt_created",
        table: "execution_attempts",
        nativeId: String(r.attempt_id),
        ts: normalizeTimestamp(r.created_at),
        trust: "authoritative",
        basis: "acs_attempt_row",
        status: str(r, "status"),
        facts: {
          attempt_number: num(r, "attempt_number"),
          terminal_at: str(r, "terminal_at"),
          started_at: str(r, "started_at"),
          outcome_code: str(r, "outcome_code"),
          recovery_reason: str(r, "recovery_reason"),
          claimed_by_worker_id: str(r, "claimed_by_worker_id"),
          plan_hash: str(r, "plan_hash")
        },
        refs: { attempt_id: String(r.attempt_id), plan_id: str(r, "plan_id") },
        raw: r
      });
    }
    for (const r of this.all("SELECT * FROM attempt_leases WHERE work_item_id = ? ORDER BY issued_at LIMIT 100", workItemId)) {
      drafts.push({
        type: "dispatch.lease_issued",
        table: "attempt_leases",
        nativeId: String(r.lease_id),
        ts: normalizeTimestamp(r.issued_at),
        trust: "authoritative",
        basis: "acs_attempt_lease",
        status: str(r, "status"),
        actor: { id: String(r.worker_id).slice(0, 160), type: "service" },
        facts: {
          fencing_epoch: num(r, "fencing_epoch"),
          expires_at: str(r, "expires_at"),
          closed_at: str(r, "closed_at"),
          policy_decision_hash: str(r, "policy_decision_hash"),
          has_approval: str(r, "approval_id") !== null,
          plan_hash: str(r, "plan_hash")
        },
        refs: {
          lease_id: String(r.lease_id),
          attempt_id: String(r.attempt_id),
          approval_id: str(r, "approval_id"),
          admission_id: str(r, "admission_id"),
          worker_id: String(r.worker_id)
        },
        causes: [
          safeId("execution_attempts", String(r.attempt_id)),
          safeId("execution_plan_admissions", String(r.admission_id)),
          r.approval_id ? safeId("execution_plan_approvals", String(r.approval_id)) : null
        ],
        raw: r
      });
    }
    for (const [table, system] of [
      ["desktop_commander_capability_issuances", "desktop_commander"],
      ["jace_commander_capability_issuances", "jace_commander"]
    ] as const) {
      for (const r of this.all(`SELECT rowid AS _rowid, * FROM ${table} WHERE work_item_id = ? ORDER BY rowid LIMIT 200`, workItemId)) {
        const native = String(r.capability_issuance_id ?? r.issuance_id ?? r._rowid);
        drafts.push({
          type: "capability.issued",
          table,
          nativeId: native,
          ts: normalizeTimestamp(r.issued_at ?? r.created_at),
          trust: "authoritative",
          basis: `acs_${system}_capability`,
          tool: str(r, "tool_name"),
          capability: system,
          facts: {
            action_hash: str(r, "action_hash"),
            request_hash: str(r, "request_hash"),
            invocation_hash: str(r, "invocation_hash"),
            has_approval: str(r, "approval_id") !== null,
            runtime_id: str(r, "runtime_id")
          },
          refs: { lease_id: str(r, "lease_id"), attempt_id: str(r, "attempt_id"), approval_id: str(r, "approval_id") },
          causes: [str(r, "lease_id") ? safeId("attempt_leases", String(r.lease_id)) : null],
          raw: { n: native, a: r.action_hash, i: r.invocation_hash }
        });
      }
    }

    // ---- results reported by workers/tools (ASSERTED: ACS proves submission, not truth)
    for (const r of this.all("SELECT * FROM attempt_results WHERE work_item_id = ? ORDER BY created_at LIMIT 100", workItemId)) {
      drafts.push(resultDraft("attempt_results", r, false));
    }
    for (const r of this.all("SELECT * FROM execution_results WHERE work_item_id = ? LIMIT 5", workItemId)) {
      drafts.push(resultDraft("execution_results", r, true));
    }
    for (const r of this.all("SELECT * FROM publication_records WHERE work_item_id = ? ORDER BY created_at LIMIT 20", workItemId)) {
      drafts.push({
        type: "result.promotion_completed",
        table: "publication_records",
        nativeId: String(r.publication_id),
        ts: normalizeTimestamp(r.created_at),
        trust: "authoritative",
        basis: "acs_publication_record",
        status: "recorded",
        facts: { commit_sha: str(r, "commit_sha") },
        refs: { attempt_id: str(r, "attempt_id") },
        untrusted: { branch: String(r.branch ?? "").slice(0, 2000) },
        raw: { id: r.publication_id, sha: r.commit_sha }
      });
    }

    // ---- independent observations
    for (const r of this.all("SELECT * FROM validation_runs WHERE work_item_id = ? ORDER BY created_at LIMIT 50", workItemId)) {
      const checks = this.all("SELECT passed FROM validation_checks WHERE run_id = ? LIMIT 200", String(r.run_id));
      drafts.push({
        type: "observation.validation_run",
        table: "validation_runs",
        nativeId: String(r.run_id),
        ts: normalizeTimestamp(r.created_at),
        trust: "observed",
        basis: "acs_validation_run",
        status: num(r, "passed") === 1 ? "passed" : "failed",
        facts: {
          passed: num(r, "passed") === 1,
          checks_total: checks.length,
          checks_failed: checks.filter((c) => num(c, "passed") !== 1).length
        },
        refs: { attempt_id: String(r.attempt_id) },
        raw: { id: r.run_id, p: r.passed }
      });
    }
    for (const r of this.all("SELECT * FROM evidence_manifests WHERE work_item_id = ? ORDER BY created_at LIMIT 50", workItemId)) {
      const verified = manifestHashOk(r);
      drafts.push({
        type: "observation.evidence_manifest",
        table: "evidence_manifests",
        nativeId: String(r.manifest_hash),
        ts: normalizeTimestamp(r.created_at),
        trust: "observed",
        basis: "acs_evidence_manifest",
        status: verified ? "hash_verified" : "hash_mismatch",
        hashVerified: verified,
        chain: verified ? "verified" : "broken",
        facts: { manifest_hash: String(r.manifest_hash), manifest_hash_valid: verified },
        refs: { attempt_id: String(r.attempt_id), manifest_hash: String(r.manifest_hash) },
        raw: { h: r.manifest_hash }
      });
    }
    for (const r of this.all("SELECT * FROM verification_requirements WHERE work_item_id = ? ORDER BY recorded_at LIMIT 50", workItemId)) {
      drafts.push({
        type: "verification.required",
        table: "verification_requirements",
        nativeId: String(r.attempt_id),
        ts: normalizeTimestamp(r.recorded_at),
        trust: "authoritative",
        basis: "acs_verification_requirement",
        facts: { reviewers_required: num(r, "reviewers_required"), policy_version: str(r, "policy_version") },
        refs: { attempt_id: String(r.attempt_id) },
        raw: { a: r.attempt_id, n: r.reviewers_required }
      });
    }
    for (const r of this.all("SELECT * FROM verification_decisions WHERE work_item_id = ? ORDER BY id LIMIT 100", workItemId)) {
      drafts.push({
        type: "verification.decided",
        table: "verification_decisions",
        nativeId: String(r.id),
        ts: normalizeTimestamp(r.decided_at),
        trust: "observed",
        basis: "acs_independent_verification_decision",
        decision: str(r, "outcome"),
        facts: { outcome: str(r, "outcome"), evidence_manifest_hash: str(r, "evidence_manifest_hash") },
        refs: { attempt_id: String(r.attempt_id), manifest_hash: String(r.evidence_manifest_hash) },
        causes: [safeId("evidence_manifests", String(r.evidence_manifest_hash))],
        raw: { id: r.id, o: r.outcome }
      });
    }

    // ---- trace projection integrity + producer release identity
    const outbox = this.all(
      "SELECT event_id, seq, canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq ASC LIMIT ?",
      workItemId,
      LIMITS.maxEventsPerWorkItem
    );
    let traceBroken = 0;
    let releaseSha: string | null = null;
    let lastOutboxTs: string | null = null;
    let instance: string | null = null;
    for (const o of outbox) {
      const ev = parseJson(o.canonical_json) as CanonicalTraceEvent | null;
      if (!ev || typeof ev !== "object") {
        traceBroken += 1;
        continue;
      }
      let ok: boolean;
      try {
        ok = canonicalTracePayloadHash(ev.payload as Record<string, unknown>) === ev.payload_hash;
        const seq = num(o, "seq") ?? 0;
        const predRow = this.one("SELECT canonical_json FROM trace_outbox WHERE seq = ?", seq - 1);
        const pred = predRow ? (parseJson(predRow.canonical_json) as CanonicalTraceEvent | null) : null;
        if (pred) ok = ok && canonicalTraceEventHash(pred) === ev.prev_hash;
        else if (seq <= 1) ok = ok && ev.prev_hash === CANONICAL_TRACE_GENESIS_HASH;
      } catch {
        ok = false;
      }
      if (!ok) traceBroken += 1;
      const sha = ev.source?.release_sha;
      if (typeof sha === "string") releaseSha = sha;
      if (typeof ev.source?.instance === "string") instance = ev.source.instance;
      lastOutboxTs = normalizeTimestamp(ev.ts) ?? lastOutboxTs;
    }
    const auditHead = this.auditHead();
    const traceHead = this.traceHead();
    drafts.push({
      type: "lifecycle.state",
      table: "work_items",
      nativeId: `${workItemId}#state`,
      ts: normalizeTimestamp(w.updated_at),
      trust: "authoritative",
      basis: "acs_work_item_row",
      status,
      facts: {
        work_item_status: status,
        audit_events: auditRows.length,
        audit_chain_broken: auditBroken,
        trace_events: outbox.length,
        trace_chain_broken: traceBroken,
        // The work item row exists (we are past the lookup) and store.create always writes its creation audit row, so
        // an existing work item with zero audit rows means its audit history was deleted, even when the table and its
        // sqlite_sequence row were wiped together to look like a fresh, never-written table.
        audit_rows_missing: auditRows.length === 0,
        audit_tail_truncated: auditHead.truncated,
        audit_head_unproven: auditHead.unproven,
        trace_tail_truncated: traceHead.truncated,
        trace_head_unproven: traceHead.unproven,
        has_trace_identity: traceId !== null
      },
      raw: { id: workItemId, status, u: w.updated_at }
    });
    if (releaseSha) {
      drafts.push({
        type: "observation.release",
        table: "trace_outbox",
        nativeId: `${workItemId}#producer`,
        ts: lastOutboxTs,
        trust: "authoritative",
        basis: "acs_producer_identity",
        facts: { scope: "acs_producer", release_sha_declared: releaseSha, instance },
        raw: { s: releaseSha, i: instance }
      });
    }

    // ---- materialise + validate against the contract
    const events: EvidenceEvent[] = [];
    let rejected = 0;
    for (const d of drafts) {
      const sanitized = d.untrusted ? sanitizeUntrusted(d.untrusted) : { value: {}, flags: [] as string[] };
      const id = safeId(d.table, d.nativeId);
      const candidate = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        event_id: id,
        trace_id: traceId,
        request_id: requestId,
        work_item_id: workItemId,
        span_id: null,
        parent_span_id: null,
        timestamp: d.ts,
        observed_at: observedAt,
        actor: d.actor ?? null,
        source: { system: "acs", component: d.table, instance },
        event_type: d.type,
        stage: stageOf(d.type),
        decision: d.decision ?? null,
        tool_name: d.tool ?? null,
        capability_id: d.capability ?? null,
        release_sha: d.type === "observation.release" ? releaseSha : null,
        status: d.status ?? null,
        evidence_ref: `acs://${d.table}/${id.slice(`acs:${d.table}.`.length)}`.slice(0, 240),
        integrity: {
          trust: d.trust,
          basis: d.basis,
          hash_verified: d.hashVerified ?? null,
          chain: d.chain ?? "not_chained",
          content_hash: contentHash(d.raw)
        },
        causes: (d.causes ?? []).filter((c): c is string => typeof c === "string"),
        facts: d.facts ?? {},
        refs: Object.fromEntries(Object.entries(d.refs ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")),
        untrusted: obj(sanitized.value),
        flags: [...new Set([...(d.flags ?? []), ...sanitized.flags])].sort()
      };
      const parsed = evidenceEventSchema.safeParse(candidate);
      if (parsed.success) events.push(parsed.data);
      else rejected += 1;
    }
    if (this.missing.size > 0) notes.push(`schema evolution: tables/columns not present: ${[...this.missing].sort().join(", ").slice(0, 160)}`);
    if (rejected > 0) notes.push(`${rejected} source rows failed the evidence schema and were excluded (not trusted)`);
    return { events, notes, missingTables: [...this.missing].sort(), rejected };
  }
}

function strAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

function resultDraft(table: string, r: Row, legacy: boolean): Draft {
  const sim = obj(parseJson(r.simulation_metadata_json));
  return {
    type: "result.reported",
    table,
    nativeId: String(r.result_id),
    ts: normalizeTimestamp(r.finished_at),
    trust: "asserted",
    basis: "worker_reported_result",
    status: str(r, "outcome"),
    actor: { id: String(r.worker_id).slice(0, 160), type: "service" },
    facts: {
      outcome: str(r, "outcome"),
      exit_code: num(r, "exit_code"),
      simulated: sim.simulated === true,
      execution_mode: typeof sim.executionMode === "string" ? (sim.executionMode as string).slice(0, 48) : null,
      legacy_result: legacy
    },
    refs: {
      result_id: String(r.result_id),
      attempt_id: str(r, "attempt_id"),
      lease_id: str(r, "lease_id"),
      worker_id: String(r.worker_id)
    },
    causes: r.lease_id && !legacy ? [safeId("attempt_leases", String(r.lease_id))] : [],
    untrusted: { summary: String(r.summary ?? "").slice(0, 2000), error: String(r.error ?? "").slice(0, 2000) },
    raw: { id: r.result_id, h: r.payload_hash, o: r.outcome }
  };
}

function approvalDraft(table: string, id: string, r: Row, st: string, anchored: boolean, legacy = false): Draft {
  const type: EventType =
    st === "consumed" ? "approval.consumed" : st === "invalidated" || st === "expired" ? "approval.invalidated" : "approval.granted";
  return {
    type,
    table,
    nativeId: id,
    ts: normalizeTimestamp(r.created_at),
    trust: "authoritative",
    basis: legacy ? "acs_approval_record" : "acs_plan_approval",
    status: st,
    actor: { id: String(r.approved_by_actor_id ?? "unknown").slice(0, 160), type: "unknown" },
    facts: {
      approval_status: st,
      expires_at: str(r, "expires_at"),
      created_at: str(r, "created_at"),
      consumed_at: str(r, "consumed_at"),
      invalidated_at: str(r, "invalidated_at"),
      action_hash: str(r, "action_hash"),
      request_hash: str(r, "request_hash"),
      plan_hash: str(r, "plan_hash"),
      audit_anchored: anchored,
      // store.create always writes an audit row, so an approval is expected to be audit-anchored even when the
      // work item has no audit rows at all (zero rows is tampering, not a reason to stop expecting the anchor).
      audit_anchor_expected: !legacy
    },
    refs: { approval_id: id.slice(0, 190) },
    untrusted: { reason: String(r.reason ?? "").slice(0, 2000) },
    flags: !anchored && !legacy ? ["no_audit_anchor"] : [],
    raw: { id, st, a: r.action_hash, c: r.created_at }
  };
}

function manifestHashOk(r: Row): boolean {
  try {
    const manifest = parseJson(r.manifest_json) as Record<string, unknown> | null;
    if (!manifest || manifest.manifestHash !== r.manifest_hash) return false;
    return verifyEvidenceManifestHash(manifest as unknown as EvidenceManifest);
  } catch {
    return false;
  }
}

interface MappedAudit {
  type: EventType;
  trust: Trust;
  basis: string;
  status?: string;
  decision?: string;
  tool?: string;
  untrusted?: boolean;
}

function mapAuditName(name: string, attrs: Record<string, unknown>): MappedAudit | null {
  switch (name) {
    case "policy.decided":
      return { type: "policy.decided", trust: "authoritative", basis: "acs_policy_audit" };
    case "approval.requested":
    case "execution.authorization_requested":
      return { type: "approval.requested", trust: "authoritative", basis: "acs_approval_audit", status: "requested" };
    case "approval.granted":
    case "execution.authorization_granted":
      return { type: "approval.granted", trust: "authoritative", basis: "acs_approval_audit", status: "granted" };
    case "approval.consumed":
      return { type: "approval.consumed", trust: "authoritative", basis: "acs_approval_audit", status: "consumed" };
    case "execution.authorization_denied":
      return { type: "approval.denied", trust: "authoritative", basis: "acs_approval_audit", status: "denied", decision: "deny" };
    case "approval.decided": {
      const d = strAttr(attrs, "approval.decision") ?? strAttr(attrs, "approval.status");
      if (d && /^(denied|rejected|deny|reject)$/iu.test(d)) {
        return { type: "approval.denied", trust: "authoritative", basis: "acs_approval_audit", status: "denied", decision: "deny" };
      }
      if (d && /^(granted|approved|allow|approve)$/iu.test(d)) {
        return { type: "approval.granted", trust: "authoritative", basis: "acs_approval_audit", status: "granted" };
      }
      return null;
    }
    case "desktop_commander.capability_issued":
    case "jace_commander.capability_issued":
      return { type: "capability.issued", trust: "authoritative", basis: "acs_capability_audit", status: "issued", tool: toolKey(name) };
    case "desktop_commander.capability_denied":
    case "jace_commander.capability_denied":
      return { type: "capability.issued", trust: "authoritative", basis: "acs_capability_audit", status: "denied", decision: "deny", tool: toolKey(name) };
    case "execution.started":
      return { type: "executor.started", trust: "asserted", basis: "worker_reported_start", status: "started" };
    case "desktop_commander.tool_called":
      return { type: "tool.started", trust: "asserted", basis: "tool_adapter_reported", status: "called", tool: "desktop_commander.tool", untrusted: true };
    case "desktop_commander.tool_succeeded":
      return { type: "tool.finished", trust: "asserted", basis: "tool_adapter_reported", status: "succeeded", tool: "desktop_commander.tool" };
    case "desktop_commander.tool_failed":
      return { type: "tool.finished", trust: "asserted", basis: "tool_adapter_reported", status: "failed", tool: "desktop_commander.tool" };
    case "execution.completed":
    case "execution.result_persisted":
      return { type: "result.reported", trust: "asserted", basis: "worker_reported_result", status: strAttr(attrs, "execution.outcome") ?? "reported" };
    default:
      return null;
  }
}

function toolKey(name: string): string {
  return name.startsWith("jace") ? "jace_commander.tool" : "desktop_commander.tool";
}
