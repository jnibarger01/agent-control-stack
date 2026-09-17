import { z } from "zod";

/**
 * The four principal roles from ADR 0015. A role is a *capability posture*, not a
 * service. `CONTROL_AUTHORITY` is ACS only. This package only ever produces
 * artifacts attributed to `ADVISORY_REASONER`; it never claims another role.
 */
export const principalRoleSchema = z.enum([
  "CONTROL_AUTHORITY",
  "ADVISORY_REASONER",
  "EXECUTION_PRINCIPAL",
  "EVIDENCE_AUTHORITY"
]);

export type PrincipalRole = z.infer<typeof principalRoleSchema>;

/**
 * Advisory artifacts (`PlanProposal`, `ReviewFinding`) are only ever authored by
 * an `ADVISORY_REASONER`. Anything else is a category error and fails closed.
 */
export function assertAdvisoryReasoner(role: unknown): asserts role is "ADVISORY_REASONER" {
  if (role !== "ADVISORY_REASONER") {
    throw new Error(`advisory artifact must be authored by an ADVISORY_REASONER, got ${String(role)}`);
  }
}
