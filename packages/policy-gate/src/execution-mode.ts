import type { PolicyDecision } from "./policy.js";

/** The only two execution-policy states. Missing or any other value is not a mode. */
export type ExecutionMode = "strict" | "admin";

export type ExecutionModeRead =
  | { state: "ok"; mode: ExecutionMode; approvalPolicy: "policy" | "auto" }
  | { state: "missing"; approvalPolicy: "deny" }
  | { state: "corrupt"; approvalPolicy: "deny"; raw: string };

export interface ManagedAuthorityObservation {
  authorityOwner: string | null;
  authoritative: boolean;
  leaseActive: boolean;
  leaseAmbiguous: boolean;
  breakGlassActive: boolean;
  breakGlassAmbiguous: boolean;
  multipleAuthoritativeExecutors: boolean;
  managedRuntime: boolean;
  detail: string;
}

export type AdminExecutionGate = { ok: true } | { ok: false; code: string; detail: string };

/**
 * Map a stored mode value. A missing row is not strict and not admin:
 * callers must fail closed. The migration inserts strict so a healthy
 * database never takes this branch.
 */
export function readExecutionModeValue(raw: string | null | undefined): ExecutionModeRead {
  if (raw == null || raw.trim() === "") {
    return { state: "missing", approvalPolicy: "deny" };
  }
  if (raw === "strict") {
    return { state: "ok", mode: "strict", approvalPolicy: "policy" };
  }
  if (raw === "admin") {
    return { state: "ok", mode: "admin", approvalPolicy: "auto" };
  }
  return { state: "corrupt", approvalPolicy: "deny", raw };
}

/**
 * Admin mode removes the human approval bottleneck only when ACS authority
 * is unambiguous. It does not convert a policy denial into an allow, and it
 * does not run when the canonical mode row is missing or corrupt.
 */
export function adminExecutionGate(
  observation: ManagedAuthorityObservation,
  authenticated: boolean
): AdminExecutionGate {
  if (!authenticated) {
    return { ok: false, code: "authentication_required", detail: "managed execution is not authenticated" };
  }
  if (observation.leaseAmbiguous || observation.breakGlassAmbiguous || observation.multipleAuthoritativeExecutors) {
    return {
      ok: false,
      code: "executor_ambiguous",
      detail: observation.detail || "executor authority is ambiguous"
    };
  }
  if (observation.breakGlassActive) {
    return { ok: false, code: "break_glass_conflict", detail: observation.detail || "break-glass is active" };
  }
  if (!observation.leaseActive || !observation.authoritative) {
    return { ok: false, code: "executor_lease_invalid", detail: observation.detail || "executor lease is not active" };
  }
  if (!observation.managedRuntime) {
    return {
      ok: false,
      code: "unmanaged_runtime",
      detail: observation.detail || "request is outside the managed runtime"
    };
  }
  return { ok: true };
}

export interface ModeAuthorization {
  /** What the caller should do with the existing approval pipeline. */
  effect: "unchanged" | "auto_authorize" | "deny";
  decision: PolicyDecision;
  code?: string;
}

/**
 * Apply the canonical mode to one policy decision.
 * strict: the existing decision is returned unchanged.
 * admin + valid authority: require_approval becomes an ACS auto-authorization.
 * admin + invalid authority, or a bad mode row: deny.
 * An underlying deny is never promoted.
 */
export function authorizeUnderExecutionMode(
  decision: PolicyDecision,
  mode: ExecutionModeRead,
  authority: AdminExecutionGate
): ModeAuthorization {
  if (decision.decision === "deny") {
    return { effect: "unchanged", decision };
  }
  if (mode.state !== "ok") {
    return {
      effect: "deny",
      code: mode.state === "missing" ? "execution_mode_missing" : "execution_mode_corrupt",
      decision: {
        decision: "deny",
        reason:
          mode.state === "missing" ? "canonical execution mode is missing" : "canonical execution mode is corrupt",
        matchedRules: ["deny:execution-mode"]
      }
    };
  }
  if (mode.mode === "strict") {
    return { effect: "unchanged", decision };
  }
  if (!authority.ok) {
    return {
      effect: "deny",
      code: authority.code,
      decision: {
        decision: "deny",
        reason: authority.detail,
        matchedRules: ["deny:admin-authority"]
      }
    };
  }
  if (decision.decision === "require_approval") {
    return {
      effect: "auto_authorize",
      decision: {
        decision: "allow",
        reason: "acs admin auto-authorization",
        matchedRules: [...decision.matchedRules, "allow:admin-auto-authorization"]
      }
    };
  }
  return { effect: "unchanged", decision };
}

export const ACS_ADMIN_APPROVER = "acs:admin";
export const ACS_ADMIN_APPROVAL_REASON = "acs admin auto-authorization";
