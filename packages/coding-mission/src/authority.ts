/**
 * Mission authority for child work, built on the existing human-issued grant model (migration 047).
 *
 * A mission's authority is an `AutonomousAuthorityDefinition`. The subset test lives in one place,
 * `authorityNarrowingViolations` in `@agent-control-stack/work-items`; this module adds only mission policy on top of it:
 *
 *   child = parent ∩ mission policy ∩ requested
 *
 * It fails closed. A child that *asks* for something its parent does not hold is denied with the reasons, never silently
 * trimmed, so an escalation attempt stays visible. Privileged privileges are never inherited by default.
 */
import { stableHash } from "@agent-control-stack/shared";
import {
  authorityNarrowingViolations,
  autonomousAuthorityDefinitionSchema,
  type AutonomousAuthorityDefinition
} from "@agent-control-stack/work-items";

export type { AutonomousAuthorityDefinition };

/** Privileges that are never inherited implicitly and need explicit mission policy to reach a child at all. */
export const PRIVILEGED_PRIVILEGES: ReadonlySet<string> = new Set([
  "process.privileged",
  "service.control",
  "deploy",
  "remote",
  "secret.read"
]);

export interface MissionAuthorityPolicy {
  /** Children never receive a privileged privilege unless this is true AND the parent holds it. Default false. */
  allowPrivilegedChildren?: boolean;
  deniedPrivileges?: string[];
  /** Upper bound on a child's lifetime from the moment it is created. */
  maxChildTtlMs?: number;
}

export type NarrowResult = { ok: true; definition: AutonomousAuthorityDefinition } | { ok: false; reasons: string[] };

/** Canonical hash of a definition. Parsing normalizes it, so equal definitions hash equally. */
export function definitionHash(definition: unknown): string {
  return stableHash({
    domain: "acs.authority-definition.v1",
    definition: autonomousAuthorityDefinitionSchema.parse(definition)
  });
}

export function narrowDefinition(input: {
  parent: unknown;
  policy?: MissionAuthorityPolicy;
  requested?: unknown;
  now: Date;
}): NarrowResult {
  const policy = input.policy ?? {};
  const parsedParent = autonomousAuthorityDefinitionSchema.safeParse(input.parent);
  if (!parsedParent.success) return { ok: false, reasons: ["parent_authority_invalid"] };
  const parent = parsedParent.data;
  if (!(Date.parse(parent.expiresAt) > input.now.getTime())) return { ok: false, reasons: ["authority_expired"] };

  const denied = new Set(policy.deniedPrivileges ?? []);
  const privilegedAllowed = policy.allowPrivilegedChildren === true;
  const ttlCeiling = policy.maxChildTtlMs === undefined ? undefined : input.now.getTime() + policy.maxChildTtlMs;
  const reasons: string[] = [];
  let candidate: AutonomousAuthorityDefinition;

  if (input.requested !== undefined) {
    const parsed = autonomousAuthorityDefinitionSchema.safeParse(input.requested);
    if (!parsed.success) return { ok: false, reasons: ["requested_authority_invalid"] };
    candidate = parsed.data;
    for (const violation of authorityNarrowingViolations(parent, candidate, input.now))
      reasons.push(`escalation:${violation}`);
    for (const privilege of candidate.maximumPrivileges) {
      if (denied.has(privilege)) reasons.push(`privilege_denied_by_mission_policy:${privilege}`);
      else if (PRIVILEGED_PRIVILEGES.has(privilege) && !privilegedAllowed)
        reasons.push(`privileged_child_not_allowed:${privilege}`);
    }
    if (ttlCeiling !== undefined && Date.parse(candidate.expiresAt) > ttlCeiling) reasons.push("expiry_exceeds_policy");
    // Authority that is already invalid when issued would consume child capacity and never be usable.
    if (!(Date.parse(candidate.expiresAt) > input.now.getTime())) reasons.push("requested_authority_expired");
  } else {
    const privileges = parent.maximumPrivileges.filter(
      (privilege) => !denied.has(privilege) && !(PRIVILEGED_PRIVILEGES.has(privilege) && !privilegedAllowed)
    );
    if (privileges.length === 0) return { ok: false, reasons: ["no_authority_remains"] };
    const expires = Math.min(Date.parse(parent.expiresAt), ttlCeiling ?? Number.POSITIVE_INFINITY);
    candidate = { ...parent, maximumPrivileges: privileges, expiresAt: new Date(expires).toISOString() };
  }
  if (reasons.length > 0) return { ok: false, reasons };

  // The invariant, asserted rather than assumed.
  const invariant = authorityNarrowingViolations(parent, candidate, input.now);
  if (invariant.length > 0) return { ok: false, reasons: ["narrowing_invariant_violated", ...invariant] };
  return { ok: true, definition: candidate };
}

/** True if `child` holds nothing `parent` does not, evaluated at a fixed instant. */
export function isSubset(child: unknown, parent: unknown, at: Date): boolean {
  return authorityNarrowingViolations(parent, child, at).length === 0;
}
