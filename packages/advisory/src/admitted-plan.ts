import { domainHash } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * `acs.admitted-plan.v1` — the ADR-0015 superset binding.
 *
 * This does NOT replace `ExecutionPlanRecord` / `ExecutionPlanAdmission` /
 * `execution_plan_approvals` (the DB-enforced floor stays exactly as-is). It is
 * the single hash that ties one admitted `ExecutionPlanDefinition` to *all*
 * materially relevant execution authority: workspace identity + base revision,
 * sandbox profile, network profile, capability profile, validation profile,
 * policy version, and (when present) the advisory proposal it derives from.
 *
 * An approval or execution authority issued for `admittedPlanHash` A must not
 * authorize `admittedPlanHash` B. Any change to any bound field yields a new
 * hash.
 */

export const ADMITTED_PLAN_SCHEMA_VERSION = "acs.admitted-plan.v1" as const;
export const ADMITTED_PLAN_HASH_DOMAIN = "acs:admitted-plan:v1" as const;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const sandboxProfileSchema = z.enum([
  "dry_run",
  "desktop_commander",
  "bubblewrap-systemd-v1",
  "engine-isolation-v1"
]);

/** `none` or `scoped-egress:<sha256 of the sorted host:port allowlist>`. */
export const networkProfileSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value === "none" || /^scoped-egress:[a-f0-9]{64}$/u.test(value),
    "networkProfile must be 'none' or 'scoped-egress:<64-hex>'"
  );

export const admittedPlanBindingSchema = z
  .object({
    schemaVersion: z.literal(ADMITTED_PLAN_SCHEMA_VERSION),
    workItemId: identifierSchema,
    /** The advisory proposal this plan derives from, or null when ACS authored it directly. */
    proposalHash: hash64.nullable(),
    /** Existing `executionPlanHash(definition)` — steps/actions/constraints. */
    executionPlanHash: hash64,
    /** Hash of the work item's requested actions, canonicalised. */
    requestedActionsHash: hash64,
    workspace: z
      .object({
        workspaceId: identifierSchema,
        /** Deterministic digest of the worktree the plan was authorized against. */
        baseRevision: z.string().min(1).max(256)
      })
      .strict(),
    sandboxProfile: sandboxProfileSchema,
    networkProfile: networkProfileSchema,
    capabilityProfileHash: hash64,
    validationProfileHash: hash64,
    policyVersion: z.string().min(1).max(128)
  })
  .strict();

export type AdmittedPlanBinding = z.infer<typeof admittedPlanBindingSchema>;
export type SandboxProfile = z.infer<typeof sandboxProfileSchema>;

export function admittedPlanHash(input: AdmittedPlanBinding): string {
  const parsed = admittedPlanBindingSchema.parse(input);
  return domainHash(ADMITTED_PLAN_HASH_DOMAIN, parsed);
}

/**
 * Fail-closed: an authority issued for `expected` must not be used against
 * `actual`. Returns the mismatched field names (empty ⇒ same authority).
 */
export function admittedPlanAuthorityMismatch(
  expected: AdmittedPlanBinding,
  actual: AdmittedPlanBinding
): string[] {
  const mismatched: string[] = [];
  const check = (field: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatched.push(field);
  };
  check("proposalHash", expected.proposalHash, actual.proposalHash);
  check("executionPlanHash", expected.executionPlanHash, actual.executionPlanHash);
  check("requestedActionsHash", expected.requestedActionsHash, actual.requestedActionsHash);
  check("workspace.workspaceId", expected.workspace.workspaceId, actual.workspace.workspaceId);
  check("workspace.baseRevision", expected.workspace.baseRevision, actual.workspace.baseRevision);
  check("sandboxProfile", expected.sandboxProfile, actual.sandboxProfile);
  check("networkProfile", expected.networkProfile, actual.networkProfile);
  check("capabilityProfileHash", expected.capabilityProfileHash, actual.capabilityProfileHash);
  check("validationProfileHash", expected.validationProfileHash, actual.validationProfileHash);
  check("policyVersion", expected.policyVersion, actual.policyVersion);
  return mismatched;
}

/** Convenience hash over an arbitrary capability/tool allowlist. */
export function capabilityProfileHash(capabilities: readonly string[]): string {
  return domainHash("acs:capability-profile:v1", { capabilities: [...capabilities].sort() });
}

/** Convenience hash over a validation/test profile. */
export function validationProfileHash(profile: {
  commands?: readonly string[][];
  requiredArtifacts?: readonly string[];
  forbiddenPaths?: readonly string[];
  allowedPaths?: readonly string[];
}): string {
  return domainHash("acs:validation-profile:v1", {
    commands: (profile.commands ?? []).map((c) => [...c]),
    requiredArtifacts: [...(profile.requiredArtifacts ?? [])].sort(),
    forbiddenPaths: [...(profile.forbiddenPaths ?? [])].sort(),
    allowedPaths: [...(profile.allowedPaths ?? [])].sort()
  });
}

/**
 * Stable workspace identity for an admitted plan.
 *
 * `AdmittedPlanBinding.workspace.workspaceId` is an identifier (`A-Za-z0-9._:-`),
 * not a filesystem path. Host paths contain slashes and must never be copied
 * into that field. Hash the containment roots instead so the binding stays
 * deterministic, attempt-traceable via the admitted-plan hash, and free of
 * raw path leakage.
 */
export function workspaceIdentityFromContainment(roots: readonly string[]): string {
  const material = [...roots]
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .sort();
  return `ws.${domainHash("acs:workspace-identity:v1", {
    roots: material.length > 0 ? material : ["none"]
  })}`;
}
