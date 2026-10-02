import { ControlStackError } from "@agent-control-stack/shared";
import type { VerificationRequirement } from "./types.js";

/** Kinds the mission runtime can evaluate. Anything else fails closed. */
export const SUPPORTED_VERIFICATION_KINDS = [
  "command_exit",
  "unit_tests",
  "integration_tests",
  "typecheck",
  "lint",
  "build",
  "repository_status",
  "file_hash",
  "service_health",
  "http_response",
  "deployment_identity",
  "git_revision",
  "service_version",
  "health_endpoint",
  "smoke",
  "vercel_production",
  "process_restart",
  "configuration"
] as const;

const supported = new Set<string>(SUPPORTED_VERIFICATION_KINDS);

export function assertSupportedVerification(requirements: readonly VerificationRequirement[], label: string): void {
  for (const requirement of requirements) {
    if (!supported.has(requirement.kind)) {
      throw new ControlStackError(
        "unsupported_verification",
        `${label} requires unsupported verification kind ${requirement.kind}`
      );
    }
    if (!requirement.expected.trim()) {
      throw new ControlStackError(
        "unsupported_verification",
        `${label} verification ${requirement.kind} has no expected condition`
      );
    }
  }
}

export function isSupportedVerificationKind(kind: string): boolean {
  return supported.has(kind);
}

export interface VerificationOutcome {
  kind: string;
  expected: string;
  observed: string;
  outcome: "passed" | "failed" | "unsupported";
  evidenceRef: string;
}

export function evaluateVerification(
  requirements: readonly VerificationRequirement[],
  observations: Record<string, string>,
  evidenceRef: string
): VerificationOutcome[] {
  return requirements.map((requirement) => {
    if (!supported.has(requirement.kind)) {
      return {
        kind: requirement.kind,
        expected: requirement.expected,
        observed: "",
        outcome: "unsupported" as const,
        evidenceRef
      };
    }
    const observed = observations[requirement.kind];
    if (observed === undefined) {
      return {
        kind: requirement.kind,
        expected: requirement.expected,
        observed: "",
        outcome: "failed" as const,
        evidenceRef
      };
    }
    return {
      kind: requirement.kind,
      expected: requirement.expected,
      observed,
      outcome: observed === requirement.expected ? ("passed" as const) : ("failed" as const),
      evidenceRef
    };
  });
}
