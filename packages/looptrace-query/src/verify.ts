import { z } from "zod";
import { View, buildGapReport, jcConflicts } from "./gaps.js";
import type { Correlated } from "./correlate.js";
import { isTrusted, type EvidenceEvent } from "./model.js";
import { observeHealth, observeInstalledReleases, type FetchLike } from "./sources/observers.js";
import { QueryError, type HealthTarget, type SourceReport } from "./types.js";

/**
 * Bounded, typed assertion registry. An assertion type exists ONLY if it can be decided from an
 * authoritative or independently observed READ-ONLY source. Unknown types are rejected; there is
 * no expression language, no caller-supplied path/URL/SQL.
 *
 * Verdicts: PASS | FAIL | INCONCLUSIVE | ERROR. Precedence FAIL > ERROR > INCONCLUSIVE > PASS.
 * "No evidence, no verified success": agent-asserted evidence can never produce PASS.
 */
export const ASSERTION_TYPES = [
  "operation_completed",
  "approval_valid",
  "release_matches",
  "service_healthy",
  "artifact_exists",
  "expected_state_observed"
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

const hex = (min: number, max: number) => z.string().regex(new RegExp(`^[a-f0-9]{${min},${max}}$`, "u"));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

export const STATE_KEYS = [
  "work_item_status",
  "attempt_status",
  "lease_status",
  "approval_status",
  "validation_passed",
  "publication_recorded"
] as const;

const assertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("operation_completed") }).strict(),
  z.object({ type: z.literal("approval_valid") }).strict(),
  z
    .object({
      type: z.literal("release_matches"),
      scope: z.enum(["acs_producer", "installed"]),
      expected_sha: hex(7, 40),
      component: name.optional()
    })
    .strict(),
  z.object({ type: z.literal("service_healthy"), target: name }).strict(),
  z.object({ type: z.literal("artifact_exists"), manifest_hash: hex(64, 64) }).strict(),
  z
    .object({
      type: z.literal("expected_state_observed"),
      key: z.enum(STATE_KEYS),
      expected: z.union([z.string().max(64), z.boolean()])
    })
    .strict()
]);
export type Assertion = z.infer<typeof assertionSchema>;

export function parseAssertions(raw: unknown): Assertion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new QueryError("INVALID_ARGUMENT", "assertions must be a non-empty array");
  }
  if (raw.length > 12) throw new QueryError("INVALID_ARGUMENT", "at most 12 assertions per call");
  return raw.map((entry, i) => {
    const t = (entry as { type?: unknown } | null)?.type;
    if (typeof t !== "string" || !(ASSERTION_TYPES as readonly string[]).includes(t)) {
      throw new QueryError(
        "UNSUPPORTED_ASSERTION",
        `assertions[${i}].type is not a supported assertion type; supported: ${ASSERTION_TYPES.join(", ")}`
      );
    }
    const parsed = assertionSchema.safeParse(entry);
    if (!parsed.success) {
      throw new QueryError("INVALID_ARGUMENT", `assertions[${i}] is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`.slice(0, 240));
    }
    return parsed.data;
  });
}

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";
const VERDICT_RANK: Record<Verdict, number> = { FAIL: 3, ERROR: 2, INCONCLUSIVE: 1, PASS: 0 };

export interface AssertionResult {
  type: AssertionType;
  verdict: Verdict;
  reason: string;
  evidence_refs: string[];
  /** Strongest trust class that actually supported the verdict ("none" when nothing trusted did). */
  trust_basis: "authoritative" | "observed" | "asserted" | "none";
}

export interface VerifyEnv {
  releaseRoots: string[];
  healthTargets: HealthTarget[];
  fetchImpl?: FetchLike | undefined;
  now: Date;
}

const refs = (...es: Array<EvidenceEvent | undefined>): string[] =>
  [...new Set(es.filter((e): e is EvidenceEvent => !!e).map((e) => e.evidence_ref))].sort();

const NEGATIVE_STATUS = new Set(["failed", "cancelled", "rejected", "quarantined", "blocked"]);

function result(type: AssertionType, verdict: Verdict, reason: string, evidence_refs: string[], trust: AssertionResult["trust_basis"]): AssertionResult {
  return { type, verdict, reason, evidence_refs: [...new Set(evidence_refs)].sort(), trust_basis: trust };
}

export function overall(results: AssertionResult[]): Verdict {
  return results.reduce<Verdict>((acc, r) => (VERDICT_RANK[r.verdict] > VERDICT_RANK[acc] ? r.verdict : acc), "PASS");
}

export async function verifyAssertions(
  assertions: Assertion[],
  v: View,
  c: Correlated,
  reports: SourceReport[],
  env: VerifyEnv
): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  for (const a of assertions) {
    try {
      out.push(await evaluate(a, v, c, reports, env));
    } catch (error) {
      out.push(result(a.type, "ERROR", `assertion could not be evaluated: ${error instanceof Error ? error.name : "error"}`, [], "none"));
    }
  }
  return out;
}

async function evaluate(a: Assertion, v: View, c: Correlated, reports: SourceReport[], env: VerifyEnv): Promise<AssertionResult> {
  switch (a.type) {
    case "operation_completed":
      return operationCompleted(v, c, reports, env.now);
    case "approval_valid":
      return approvalValid(v);
    case "release_matches":
      return releaseMatches(a, v, env);
    case "service_healthy": {
      const o = await observeHealth(env.healthTargets, a.target, env.fetchImpl);
      const ref = `observer://health/${a.target}`;
      if (o.outcome === "healthy") return result(a.type, "PASS", `${o.detail} from allowlisted target '${a.target}' at ${env.now.toISOString()} (point-in-time observation)`, [ref], "observed");
      if (o.outcome === "unhealthy") return result(a.type, "FAIL", `${o.detail} from allowlisted target '${a.target}'`, [ref], "observed");
      if (o.outcome === "unknown_target") return result(a.type, "ERROR", o.detail, [], "none");
      return result(a.type, "INCONCLUSIVE", `target unreachable from the verifier (${o.detail}); this is not proof the service is down`, [ref], "none");
    }
    case "artifact_exists": {
      const manifests = v.of("observation.evidence_manifest").filter((e) => e.facts.manifest_hash === a.manifest_hash);
      const m = manifests[0];
      if (!m) return result(a.type, "INCONCLUSIVE", "no evidence manifest with that hash is recorded for this work item", [], "none");
      if (m.integrity.hash_verified === false) return result(a.type, "FAIL", "the recorded manifest does not hash to its recorded manifest hash (tampering or corruption)", refs(m), "observed");
      return result(a.type, "PASS", "a hash-verified evidence manifest with that hash is recorded (the manifest pins the artifact set; the files themselves are not re-read)", refs(m), "observed");
    }
    case "expected_state_observed":
      return expectedState(a, v);
  }
}

function integrityViolations(v: View): EvidenceEvent[] {
  return [
    ...v.events.filter((e) => e.integrity.chain === "broken" || e.integrity.hash_verified === false),
    ...(v.state && ((v.state.facts.audit_chain_broken as number) > 0 || (v.state.facts.trace_chain_broken as number) > 0) ? [v.state] : [])
  ];
}

function operationCompleted(v: View, c: Correlated, reports: SourceReport[], now: Date): AssertionResult {
  const T = "operation_completed" as const;
  const state = v.state;
  if (!state) return result(T, "INCONCLUSIVE", "no authoritative work item state is available", [], "none");
  if (reports.some((r) => r.source === "acs" && r.status !== "ok")) {
    return result(T, "ERROR", "the authoritative ACS source is not readable", [], "none");
  }
  const violations = integrityViolations(v);
  if (violations.length > 0) {
    return result(T, "ERROR", "evidence integrity check failed (hash/chain mismatch); the outcome cannot be verified from this evidence", refs(...violations), "none");
  }
  const status = v.status ?? "unknown";
  const validations = v.of("observation.validation_run");
  const decisions = v.of("verification.decided");
  const results = v.of("result.reported");

  const rejected = decisions.filter((e) => e.decision === "attempt_rejected");
  const failedValidation = validations.filter((e) => e.facts.passed === false);
  if (NEGATIVE_STATUS.has(status)) {
    return result(T, "FAIL", `authoritative work item state is '${status}'`, refs(state), "authoritative");
  }
  if (rejected.length > 0 || failedValidation.length > 0) {
    return result(T, "FAIL", "an independent observation contradicts completion (rejected verification decision or failed validation run)", refs(state, ...rejected, ...failedValidation), "observed");
  }
  const reportedNegative = results.filter((e) => typeof e.facts.outcome === "string" && ["failed", "cancelled", "blocked"].includes(e.facts.outcome as string));
  if (status === "succeeded" && reportedNegative.length > 0) {
    return result(T, "FAIL", "the work item is recorded as succeeded but a recorded result reports a negative outcome (contradiction)", refs(state, ...reportedNegative), "authoritative");
  }
  if (status !== "succeeded") {
    return result(T, "INCONCLUSIVE", `work item is '${status}', which is not a completed state`, refs(state), "authoritative");
  }
  const simulated = results.filter((e) => e.facts.simulated === true);
  if (simulated.length > 0) {
    return result(T, "INCONCLUSIVE", "the recorded result is from a simulated (dry-run) execution and proves no real change", refs(state, ...simulated), "none");
  }
  const jcDisagree = jcConflicts(v);
  if (jcDisagree.length > 0) {
    return result(T, "INCONCLUSIVE", "ACS records success but the Jace Commander trace reports only failed tool calls for this work item; an unresolved conflict between the executor's own record and ACS cannot support a PASS", refs(state, ...jcDisagree), "asserted");
  }
  const validated = validations.filter((e) => e.facts.passed === true && isTrusted(e.integrity.trust));
  const accepted = decisions.filter((e) => {
    if (e.decision !== "attempt_accepted") return false;
    const mh = e.facts.evidence_manifest_hash;
    return v.of("observation.evidence_manifest").some((m) => m.facts.manifest_hash === mh && m.integrity.hash_verified === true);
  });
  if (validated.length > 0 || accepted.length > 0) {
    const basis = [...validated, ...accepted];
    return result(T, "PASS", "completion is supported by independent evidence (passed validation run and/or accepted verification decision bound to a hash-verified manifest)", refs(state, ...basis, ...v.of("observation.evidence_manifest").filter((m) => accepted.some((d) => d.facts.evidence_manifest_hash === m.facts.manifest_hash))), "observed");
  }
  void c;
  void now;
  return result(
    T,
    "INCONCLUSIVE",
    "success is recorded, but only the worker's own report supports it; no independent observation (validation run or accepted verification decision) exists",
    refs(state, ...results),
    "asserted"
  );
}

function approvalValid(v: View): AssertionResult {
  const T = "approval_valid" as const;
  const admissions = v.of("dispatch.admitted");
  const policy = v.of("policy.decided");
  const required = admissions.some((e) => e.facts.requires_approval === true) || policy.some((e) => e.decision === "require_approval");
  const notRequired = admissions.length > 0 && admissions.every((e) => e.facts.requires_approval === false) && !policy.some((e) => e.decision === "require_approval");
  const approvals = v.events.filter((e) => e.stage === "approval");
  const leases = v.of("dispatch.lease_issued");
  const denied = v.of("approval.denied");
  const bad = approvals.filter((e) => e.status === "invalidated" || e.status === "expired");
  if (denied.length > 0) return result(T, "FAIL", "an approval denial is recorded", refs(...denied), "authoritative");
  if (!required) {
    if (notRequired) return result(T, "PASS", "the plan admission records that no approval was required", refs(...admissions), "authoritative");
    return result(T, "INCONCLUSIVE", "no plan admission/policy evidence establishes whether approval was required", refs(...admissions), "none");
  }
  const granted = approvals.filter((e) => e.status === "granted" || e.status === "consumed");
  if (granted.length === 0) {
    return result(T, bad.length > 0 ? "FAIL" : "INCONCLUSIVE", bad.length > 0 ? "the only approval records are invalidated/expired" : "approval is required but no approval record exists", refs(...bad, ...admissions), "authoritative");
  }
  const byId = new Map(approvals.filter((e) => e.refs.approval_id).map((e) => [e.refs.approval_id!, e]));
  for (const lease of leases) {
    const a = lease.refs.approval_id ? byId.get(lease.refs.approval_id) : undefined;
    if (!a) return result(T, "FAIL", "a lease was issued without a resolvable bound approval although approval is required", refs(lease, ...granted), "authoritative");
    const exp = typeof a.facts.expires_at === "string" ? Date.parse(a.facts.expires_at) : NaN;
    const issued = lease.timestamp ? Date.parse(lease.timestamp) : NaN;
    if (a.status === "invalidated" || a.status === "expired" || (!Number.isNaN(exp) && !Number.isNaN(issued) && exp < issued)) {
      return result(T, "FAIL", "the approval bound to a lease was invalid at lease issuance", refs(a, lease), "authoritative");
    }
  }
  const unanchored = granted.filter((e) => e.flags.includes("no_audit_anchor"));
  if (unanchored.length > 0) {
    return result(T, "INCONCLUSIVE", "the approval row has no corresponding audit event; the audit chain does not vouch for it", refs(...unanchored), "none");
  }
  return result(T, "PASS", "a granted approval exists, is audit-anchored, and was unexpired and bound at each lease issuance", refs(...granted, ...leases), "authoritative");
}

function releaseMatches(a: Extract<Assertion, { type: "release_matches" }>, v: View, env: VerifyEnv): AssertionResult {
  const T = "release_matches" as const;
  if (a.scope === "acs_producer") {
    const ev = v.of("observation.release")[0];
    const declared = typeof ev?.facts.release_sha_declared === "string" ? ev.facts.release_sha_declared : null;
    if (!ev || !declared) return result(T, "INCONCLUSIVE", "no producer release identity is recorded for this work item", [], "none");
    if (!/^[a-f0-9]{40}$/u.test(declared)) return result(T, "INCONCLUSIVE", `the ACS producer ran an unpinned build ('${declared.slice(0, 20)}')`, refs(ev), "authoritative");
    return declared.startsWith(a.expected_sha)
      ? result(T, "PASS", "the ACS producer release recorded in the trace stream matches the expected sha (this identifies the ACS control plane, not the executing worker)", refs(ev), "authoritative")
      : result(T, "FAIL", "the ACS producer release recorded in the trace stream differs from the expected sha", refs(ev), "authoritative");
  }
  if (!a.component) return result(T, "ERROR", "scope 'installed' requires a component name", [], "none");
  const installed = observeInstalledReleases(env.releaseRoots, a.component);
  if (installed === null) return result(T, "INCONCLUSIVE", "no configured release root contains that component, or the release observer is not configured", [], "none");
  const hit = installed.find((r) => r.commit.startsWith(a.expected_sha));
  const ref = hit ? [`observer://release/${a.component}/${hit.dir}`] : [];
  if (!hit) return result(T, "INCONCLUSIVE", "no installed release of that component has the expected commit (the running version is not observable by this tool)", [], "none");
  if (!hit.dirMatchesCommit) return result(T, "FAIL", "the installed release directory name disagrees with the commit in its RELEASE.json", ref, "observed");
  return result(T, "PASS", "a release with the expected commit is installed and internally consistent (installed is not the same as running)", ref, "observed");
}

function expectedState(a: Extract<Assertion, { type: "expected_state_observed" }>, v: View): AssertionResult {
  const T = "expected_state_observed" as const;
  const latest = (es: EvidenceEvent[]): EvidenceEvent | undefined => es[es.length - 1];
  let actual: string | boolean | null = null;
  let basis: EvidenceEvent[] = [];
  switch (a.key) {
    case "work_item_status":
      actual = v.status;
      basis = v.state ? [v.state] : [];
      break;
    case "attempt_status": {
      const e = latest(v.of("dispatch.attempt_created"));
      actual = e?.status ?? null;
      basis = e ? [e] : [];
      break;
    }
    case "lease_status": {
      const e = latest(v.of("dispatch.lease_issued"));
      actual = e?.status ?? null;
      basis = e ? [e] : [];
      break;
    }
    case "approval_status": {
      const e = latest(v.events.filter((x) => x.stage === "approval"));
      actual = e?.status ?? null;
      basis = e ? [e] : [];
      break;
    }
    case "validation_passed": {
      const runs = v.of("observation.validation_run");
      actual = runs.length === 0 ? null : runs.every((r) => r.facts.passed === true);
      basis = runs;
      break;
    }
    case "publication_recorded": {
      const p = v.of("result.promotion_completed");
      // No record is not a negative observation: absence cannot establish that nothing was published.
      actual = p.length > 0 ? true : null;
      basis = p;
      break;
    }
  }
  const trusted = basis.filter((e) => isTrusted(e.integrity.trust));
  if (actual === null || (basis.length > 0 && trusted.length === 0)) {
    return result(T, "INCONCLUSIVE", `no trusted observation of '${a.key}' is available`, refs(...basis), "none");
  }
  if (violationsIn(basis)) return result(T, "ERROR", "the observation's integrity check failed", refs(...basis), "none");
  if (actual === a.expected) return result(T, "PASS", `${a.key} observed equal to the expected value`, refs(...trusted), trusted.some((e) => e.integrity.trust === "observed") ? "observed" : "authoritative");
  return result(T, "FAIL", `${a.key} observed as '${String(actual)}', expected '${String(a.expected)}'`, refs(...trusted), trusted.some((e) => e.integrity.trust === "observed") ? "observed" : "authoritative");
}

function violationsIn(es: EvidenceEvent[]): boolean {
  return es.some((e) => e.integrity.chain === "broken" || e.integrity.hash_verified === false);
}

export { buildGapReport };
