import type { Correlated } from "./correlate.js";
import { SEVERITY_RANK, isTrusted, type EvidenceEvent, type EventType, type Severity, type Stage } from "./model.js";
import type { SourceReport } from "./types.js";

export interface Gap {
  code: string;
  severity: Severity;
  affected_stage: Stage | "lifecycle" | "integrity" | "sources";
  description: string;
  required_evidence: string;
  evidence_refs: string[];
}

export type Completeness = "complete" | "partial" | "unknown";

export interface GapReport {
  completeness: Completeness;
  required_stages: Stage[];
  observed_stages: Stage[];
  gaps: Gap[];
}

/** Typed read access to one work item's events. */
export class View {
  constructor(
    readonly workItemId: string,
    readonly events: EvidenceEvent[]
  ) {}
  of(...types: EventType[]): EvidenceEvent[] {
    return this.events.filter((e) => types.includes(e.event_type));
  }
  get state(): EvidenceEvent | undefined {
    return this.of("lifecycle.state")[0];
  }
  get status(): string | null {
    const v = this.state?.facts.work_item_status;
    return typeof v === "string" ? v : null;
  }
  fact(e: EvidenceEvent | undefined, key: string): string | number | boolean | null {
    return e?.facts[key] ?? null;
  }
  refs(...es: Array<EvidenceEvent | undefined>): string[] {
    return [...new Set(es.filter((e): e is EvidenceEvent => !!e).map((e) => e.evidence_ref))].sort();
  }
}

const EXECUTION_STATUSES = new Set(["running", "succeeded", "failed", "cancelling", "unknown", "quarantined"]);
const TERMINAL_ATTEMPT = new Set(["succeeded", "failed", "cancelled"]);
const INDETERMINATE_ATTEMPT = new Set(["unknown", "quarantined", "interrupted"]);

export function isDispatched(v: View): boolean {
  if (v.of("dispatch.lease_issued", "capability.issued").length > 0) return true;
  if (v.of("dispatch.attempt_created").some((e) => e.status && e.status !== "pending")) return true;
  return v.status !== null && EXECUTION_STATUSES.has(v.status);
}

export function approvalRequired(v: View): boolean {
  if (v.of("dispatch.admitted").some((e) => e.facts.requires_approval === true)) return true;
  if (v.of("policy.decided").some((e) => e.decision === "require_approval")) return true;
  return v.status === "needs_approval";
}

export function requiredStages(v: View): Stage[] {
  const out: Stage[] = ["request"];
  const dispatched = isDispatched(v);
  if (dispatched || v.status === "approved" || v.status === "needs_approval") out.push("policy");
  if (approvalRequired(v)) out.push("approval");
  if (v.of("route.decided").length > 0) out.push("routing");
  if (dispatched) out.push("dispatch");
  if (dispatched && v.status !== null && EXECUTION_STATUSES.has(v.status)) out.push("tool_execution");
  if (v.status === "succeeded" || v.status === "failed") out.push("result");
  if (v.status === "succeeded") out.push("observation");
  if (v.of("verification.required").some((e) => (e.facts.reviewers_required as number) > 0)) out.push("verification");
  return STAGE_ORDER.filter((s) => out.includes(s));
}
const STAGE_ORDER: Stage[] = ["request", "routing", "policy", "approval", "dispatch", "tool_execution", "result", "observation", "verification"];

export function observedStages(v: View): Stage[] {
  const seen = new Set<Stage>();
  for (const e of v.events) if (e.stage !== "lifecycle") seen.add(e.stage);
  // Tool execution can also be evidenced by an attempt that ran and produced a reported result.
  return STAGE_ORDER.filter((s) => seen.has(s));
}

export function analyzeWorkItem(v: View, now: Date): Gap[] {
  const gaps: Gap[] = [];
  const add = (g: Gap): void => void gaps.push({ ...g, evidence_refs: [...new Set(g.evidence_refs)].sort() });
  const status = v.status;
  const dispatched = isDispatched(v);
  const state = v.state;

  // ---- policy
  const policy = v.of("policy.decided");
  const admissions = v.of("dispatch.admitted");
  if ((dispatched || status === "approved") && policy.length === 0 && admissions.length === 0) {
    add({
      code: "MISSING_POLICY_DECISION",
      severity: "high",
      affected_stage: "policy",
      description: "Work was dispatched/approved but no policy decision or plan admission is recorded.",
      required_evidence: "policy.decided audit event or execution_plan_admissions row binding a policy decision hash",
      evidence_refs: v.refs(state)
    });
  }
  for (const p of policy) {
    if (p.decision === "deny" && dispatched) {
      add({
        code: "POLICY_DENIED_BUT_EXECUTED",
        severity: "critical",
        affected_stage: "policy",
        description: "A policy decision of deny exists but the work item was dispatched.",
        required_evidence: "an allowing policy decision superseding the denial, or no dispatch",
        evidence_refs: v.refs(p, ...v.of("dispatch.lease_issued"))
      });
    }
  }

  // ---- approval
  const needsApproval = approvalRequired(v);
  const approvals = v.of("approval.granted", "approval.consumed");
  const denied = v.of("approval.denied");
  if (needsApproval && dispatched && approvals.length === 0) {
    add({
      code: "MISSING_APPROVAL_EVIDENCE",
      severity: "high",
      affected_stage: "approval",
      description: "Approval was required by policy/admission and work was dispatched, but no approval record exists.",
      required_evidence: "execution_plan_approvals (or approval_records) row with status granted/consumed",
      evidence_refs: v.refs(...admissions, ...policy)
    });
  }
  if (denied.length > 0 && dispatched) {
    add({
      code: "APPROVAL_DENIED_BUT_EXECUTED",
      severity: "critical",
      affected_stage: "approval",
      description: "An approval denial is recorded but the work item was dispatched.",
      required_evidence: "a later valid approval, or no dispatch",
      evidence_refs: v.refs(...denied, ...v.of("dispatch.lease_issued"))
    });
  }
  const approvalByRef = new Map(v.events.filter((e) => e.stage === "approval" && e.refs.approval_id).map((e) => [e.refs.approval_id!, e]));
  for (const lease of v.of("dispatch.lease_issued")) {
    const aid = lease.refs.approval_id;
    if (needsApproval && !aid) {
      add({
        code: "APPROVAL_NOT_BOUND_TO_LEASE",
        severity: "high",
        affected_stage: "approval",
        description: "Approval was required but a lease was issued without a bound approval id.",
        required_evidence: "attempt_leases.approval_id referencing a granted plan approval",
        evidence_refs: v.refs(lease)
      });
    }
    if (aid) {
      const a = approvalByRef.get(aid);
      if (!a) {
        add({
          code: "APPROVAL_REFERENCE_UNRESOLVED",
          severity: "high",
          affected_stage: "approval",
          description: "A lease references an approval that is not present in the evidence.",
          required_evidence: "execution_plan_approvals row for the referenced approval id",
          evidence_refs: v.refs(lease)
        });
      } else {
        const st = a.facts.approval_status;
        const exp = typeof a.facts.expires_at === "string" ? Date.parse(a.facts.expires_at) : NaN;
        const issued = lease.timestamp ? Date.parse(lease.timestamp) : NaN;
        if (st === "invalidated" || st === "expired" || (!Number.isNaN(exp) && !Number.isNaN(issued) && exp < issued)) {
          add({
            code: "APPROVAL_INVALID",
            severity: "critical",
            affected_stage: "approval",
            description: "The approval bound to a lease was invalidated/expired or expired before the lease was issued.",
            required_evidence: "an approval valid at lease issuance time",
            evidence_refs: v.refs(a, lease)
          });
        }
      }
    }
  }
  for (const a of v.events.filter((e) => e.stage === "approval" && e.flags.includes("no_audit_anchor"))) {
    add({
      code: "APPROVAL_WITHOUT_AUDIT_ANCHOR",
      severity: "high",
      affected_stage: "approval",
      description: "An approval row exists with no corresponding audit event; the audit chain does not vouch for it (possible out-of-band write).",
      required_evidence: "approval.* audit event carrying this approval id",
      evidence_refs: v.refs(a)
    });
  }

  // ---- routing
  const assignment = v.of("route.decided").find((e) => typeof e.facts.selected_worker_id === "string");
  if (assignment && dispatched) {
    const selected = assignment.facts.selected_worker_id as string;
    const workers = new Set(v.of("dispatch.lease_issued").map((e) => e.refs.worker_id).filter((x): x is string => !!x));
    if (workers.size > 0 && !workers.has(selected)) {
      add({
        code: "ROUTE_EXECUTOR_MISMATCH",
        severity: "medium",
        affected_stage: "routing",
        description: "The recorded assignment selected a worker that never held a lease for this work item.",
        required_evidence: "lease held by the assigned worker, or a recorded reassignment",
        evidence_refs: v.refs(assignment, ...v.of("dispatch.lease_issued"))
      });
    }
  }

  // ---- attempts / leases
  const attempts = v.of("dispatch.attempt_created");
  for (const at of attempts) {
    if (at.status && INDETERMINATE_ATTEMPT.has(at.status)) {
      add({
        code: "ATTEMPT_INDETERMINATE",
        severity: "high",
        affected_stage: "tool_execution",
        description: `Attempt is recorded as '${at.status}': the outcome of execution is not known.`,
        required_evidence: "a terminal attempt state backed by a reported result and independent observation",
        evidence_refs: v.refs(at)
      });
    }
  }
  for (const lease of v.of("dispatch.lease_issued")) {
    const exp = typeof lease.facts.expires_at === "string" ? Date.parse(lease.facts.expires_at) : NaN;
    const attempt = attempts.find((a) => a.refs.attempt_id === lease.refs.attempt_id);
    const attemptTerminal = attempt?.status ? TERMINAL_ATTEMPT.has(attempt.status) : false;
    if (lease.status === "active" && !Number.isNaN(exp) && exp < now.getTime() && !attemptTerminal) {
      add({
        code: "ATTEMPT_ABANDONED",
        severity: "high",
        affected_stage: "tool_execution",
        description: "A lease is still active past its expiry and its attempt has no terminal state (worker crashed or stalled).",
        required_evidence: "terminal attempt state or lease close/expiry record",
        evidence_refs: v.refs(lease, attempt)
      });
    }
  }

  // ---- tool execution timeline
  const started = v.of("tool.started");
  const finished = v.of("tool.finished");
  const attemptsTerminal = attempts.length > 0 && attempts.every((a) => a.status && TERMINAL_ATTEMPT.has(a.status));
  if (started.length > finished.length && attemptsTerminal) {
    add({
      code: "TOOL_INVOCATION_WITHOUT_OUTCOME",
      severity: "medium",
      affected_stage: "tool_execution",
      description: `${started.length} tool invocation(s) recorded but only ${finished.length} outcome(s).`,
      required_evidence: "tool_succeeded/tool_failed event for every tool_called event",
      evidence_refs: v.refs(...started, ...finished)
    });
  }
  if (finished.length > started.length) {
    add({
      code: "TOOL_OUTCOME_WITHOUT_INVOCATION",
      severity: "medium",
      affected_stage: "tool_execution",
      description: `${finished.length} tool outcome(s) recorded for only ${started.length} invocation(s).`,
      required_evidence: "tool_called event preceding every tool outcome",
      evidence_refs: v.refs(...started, ...finished)
    });
  }
  if (v.of("capability.issued").some((e) => e.decision === "deny") && finished.some((e) => e.status === "succeeded")) {
    add({
      code: "CAPABILITY_DENIED_BUT_TOOL_SUCCEEDED",
      severity: "critical",
      affected_stage: "tool_execution",
      description: "A capability denial is recorded alongside a successful tool outcome.",
      required_evidence: "an issued capability preceding the tool call",
      evidence_refs: v.refs(...v.of("capability.issued"), ...finished)
    });
  }

  // ---- results / outcome evidence
  const results = v.of("result.reported");
  const validations = v.of("observation.validation_run");
  const manifests = v.of("observation.evidence_manifest");
  const decisions = v.of("verification.decided");
  const terminal = status === "succeeded" || status === "failed";
  if (terminal && results.length === 0) {
    add({
      code: "MISSING_RESULT_RECORD",
      severity: "high",
      affected_stage: "result",
      description: `Work item is '${status}' but no result record exists.`,
      required_evidence: "attempt_results / execution_results row",
      evidence_refs: v.refs(state)
    });
  }
  if (status === "succeeded") {
    const independent = validations.some((e) => e.facts.passed === true) || decisions.some((e) => e.decision === "attempt_accepted");
    if (!independent) {
      add({
        code: "MISSING_OUTCOME_EVIDENCE",
        severity: "medium",
        affected_stage: "observation",
        description: "Success is recorded, but no independent observation (passed validation run or accepted verification decision) supports it; it rests on the worker's own report.",
        required_evidence: "validation_runs.passed=1 or verification_decisions.outcome=attempt_accepted with a hash-verified evidence manifest",
        evidence_refs: v.refs(state, ...results)
      });
    }
    if (results.some((e) => e.facts.simulated === true)) {
      add({
        code: "SIMULATED_EXECUTION",
        severity: "medium",
        affected_stage: "result",
        description: "The recorded result is from a simulated (dry-run) execution; it is not evidence that a real change happened.",
        required_evidence: "a non-simulated execution result",
        evidence_refs: v.refs(...results)
      });
    }
  }
  // Contradictions between authoritative state, worker reports and independent observations.
  const reportedOutcomes = new Set(results.map((e) => e.facts.outcome).filter((x): x is string => typeof x === "string"));
  const contradictions: EvidenceEvent[] = [];
  if (status === "succeeded") {
    if ([...reportedOutcomes].some((o) => o === "failed" || o === "cancelled" || o === "blocked")) contradictions.push(...results);
    contradictions.push(...validations.filter((e) => e.facts.passed === false));
    contradictions.push(...decisions.filter((e) => e.decision === "attempt_rejected"));
  }
  if (status === "failed" && reportedOutcomes.has("succeeded")) {
    contradictions.push(...results);
  }
  if (validations.some((e) => e.facts.passed === true) && decisions.some((e) => e.decision === "attempt_rejected")) {
    contradictions.push(...validations, ...decisions);
  }
  if (contradictions.length > 0) {
    add({
      code: "CONFLICTING_OUTCOME",
      severity: "high",
      affected_stage: "result",
      description: "Recorded outcomes disagree (state vs worker result vs independent observation).",
      required_evidence: "a single consistent outcome across state, results and observations",
      evidence_refs: v.refs(state, ...contradictions)
    });
  }

  // ---- verification
  const needVerify = v.of("verification.required").filter((e) => (e.facts.reviewers_required as number) > 0);
  if (needVerify.length > 0 && decisions.length === 0 && terminal) {
    add({
      code: "MISSING_VERIFICATION_DECISION",
      severity: "medium",
      affected_stage: "verification",
      description: "Independent verification is required but no verification decision is recorded.",
      required_evidence: "verification_decisions row for the attempt",
      evidence_refs: v.refs(...needVerify)
    });
  }
  for (const m of manifests.filter((e) => e.integrity.hash_verified === false)) {
    add({
      code: "EVIDENCE_HASH_MISMATCH",
      severity: "critical",
      affected_stage: "observation",
      description: "An evidence manifest does not hash to its recorded manifest hash.",
      required_evidence: "an unmodified, hash-verified evidence manifest",
      evidence_refs: v.refs(m)
    });
  }
  for (const d of decisions) {
    const mh = typeof d.facts.evidence_manifest_hash === "string" ? d.facts.evidence_manifest_hash : null;
    if (mh && !manifests.some((m) => m.facts.manifest_hash === mh)) {
      add({
        code: "VERIFICATION_MANIFEST_MISSING",
        severity: "high",
        affected_stage: "verification",
        description: "A verification decision references an evidence manifest that is not present.",
        required_evidence: "evidence_manifests row for the referenced hash",
        evidence_refs: v.refs(d)
      });
    }
  }

  // ---- provenance / integrity
  if (dispatched) {
    add({
      code: "MISSING_RELEASE_IDENTITY",
      severity: "low",
      affected_stage: "tool_execution",
      description: "ACS does not record which release of the executor/worker ran the attempt (only the ACS producer release is known), so executed-release claims cannot be verified.",
      required_evidence: "executor release sha recorded on the lease/result or reported by an independent release observer",
      evidence_refs: v.refs(...v.of("dispatch.lease_issued"))
    });
    if (state?.facts.audit_events === 0) {
      add({
        code: "MISSING_AUDIT_TRAIL",
        severity: "high",
        affected_stage: "integrity",
        description: "The work item was dispatched but has no audit events.",
        required_evidence: "hash-chained audit events for the work item",
        evidence_refs: v.refs(state)
      });
    }
    if (state?.facts.trace_events === 0) {
      add({
        code: "TRACE_PROJECTION_MISSING",
        severity: "medium",
        affected_stage: "integrity",
        description: "No trace-event/1 projection rows exist for a dispatched work item.",
        required_evidence: "trace_outbox rows for the work item",
        evidence_refs: v.refs(state)
      });
    }
    if (state?.facts.has_trace_identity === false) {
      add({
        code: "MISSING_TRACE_IDENTITY",
        severity: "low",
        affected_stage: "integrity",
        description: "The work item has no trace_id mapping.",
        required_evidence: "trace_missions row",
        evidence_refs: v.refs(state)
      });
    }
  }
  if (typeof state?.facts.audit_chain_broken === "number" && state.facts.audit_chain_broken > 0) {
    add({
      code: "AUDIT_CHAIN_LINK_BROKEN",
      severity: "critical",
      affected_stage: "integrity",
      description: `${state.facts.audit_chain_broken} audit event(s) failed hash/link verification.`,
      required_evidence: "an intact audit hash chain",
      evidence_refs: v.refs(state, ...v.events.filter((e) => e.integrity.chain === "broken"))
    });
  }
  if (typeof state?.facts.trace_chain_broken === "number" && state.facts.trace_chain_broken > 0) {
    add({
      code: "TRACE_CHAIN_BROKEN",
      severity: "high",
      affected_stage: "integrity",
      description: `${state.facts.trace_chain_broken} trace projection event(s) failed payload-hash or predecessor linkage checks.`,
      required_evidence: "an intact trace-event/1 chain",
      evidence_refs: v.refs(state)
    });
  }
  const injected = v.events.filter((e) => e.flags.includes("injection_suspected"));
  if (injected.length > 0) {
    add({
      code: "UNTRUSTED_INSTRUCTION_LIKE_CONTENT",
      severity: "info",
      affected_stage: "integrity",
      description: "Some source-supplied text looks like instructions to a model. It was treated as inert data and had no influence on any verdict.",
      required_evidence: "none (informational)",
      evidence_refs: v.refs(...injected)
    });
  }
  return gaps;
}

export function analyzeCorrelation(c: Correlated, v: View | null): Gap[] {
  const gaps: Gap[] = [];
  if (c.conflicts.length > 0) {
    gaps.push({
      code: "EVENT_CONFLICT",
      severity: "high",
      affected_stage: "integrity",
      description: `${c.conflicts.length} event id(s) were observed with different content; the first-seen version is shown and the conflict is unresolved.`,
      required_evidence: "a single immutable record per event id",
      evidence_refs: c.conflicts.map((x) => x.event_id).sort()
    });
  }
  if (c.duplicates.length > 0) {
    gaps.push({
      code: "DUPLICATE_EVENT",
      severity: "info",
      affected_stage: "integrity",
      description: `${c.duplicates.length} duplicate event(s) were collapsed (identical event ids).`,
      required_evidence: "none (informational)",
      evidence_refs: c.duplicates.slice(0, 20)
    });
  }
  if (c.skew.length > 0) {
    gaps.push({
      code: "CLOCK_SKEW",
      severity: "low",
      affected_stage: "integrity",
      description: `${c.skew.length} event(s) are timestamped before the events that caused them; source clocks disagree or timestamps are wrong. Ordering was not altered.`,
      required_evidence: "monotonic or synchronised source clocks",
      evidence_refs: c.skew.slice(0, 20).map((s) => s.effect)
    });
  }
  if (c.missingCauses.length > 0) {
    gaps.push({
      code: "LOST_PARENT_SPAN",
      severity: "medium",
      affected_stage: "integrity",
      description: `${c.missingCauses.length} event(s) reference a causal predecessor that is not present in the evidence.`,
      required_evidence: "the referenced predecessor events",
      evidence_refs: c.missingCauses.slice(0, 20).map((m) => m.event_id)
    });
  }
  if (c.untimed.length > 0) {
    gaps.push({
      code: "MISSING_TIMESTAMP",
      severity: "low",
      affected_stage: "integrity",
      description: `${c.untimed.length} event(s) have no usable timestamp and were ordered last.`,
      required_evidence: "an ISO-8601 timestamp on every record",
      evidence_refs: c.untimed.slice(0, 20)
    });
  }
  void v;
  return gaps;
}

export function sourceGaps(reports: SourceReport[]): Gap[] {
  return reports
    .filter((r) => r.status === "unavailable" || r.status === "error")
    .map((r) => ({
      code: "SOURCE_UNAVAILABLE",
      severity: "medium" as const,
      affected_stage: "sources" as const,
      description: `Evidence source '${r.source}' is ${r.status}; its evidence is absent from this report (absence is not evidence of absence).`,
      required_evidence: `a reachable ${r.source} source`,
      evidence_refs: []
    }));
}

export function completenessOf(gaps: Gap[], eventCount: number, reports: SourceReport[]): Completeness {
  if (eventCount === 0) return "unknown";
  if (reports.some((r) => r.status === "unavailable" || r.status === "error")) return "partial";
  const material = gaps.filter((g) => SEVERITY_RANK[g.severity] >= SEVERITY_RANK.medium);
  return material.length === 0 ? "complete" : "partial";
}

export function buildGapReport(v: View, c: Correlated, reports: SourceReport[], now: Date): GapReport {
  const gaps = [...analyzeWorkItem(v, now), ...analyzeCorrelation(c, v), ...sourceGaps(reports)].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.code.localeCompare(b.code)
  );
  const observed = observedStages(v);
  return {
    completeness: completenessOf(gaps, v.events.length, reports),
    required_stages: requiredStages(v),
    observed_stages: observed,
    gaps
  };
}
export { isTrusted };
