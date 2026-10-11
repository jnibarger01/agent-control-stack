import { isAbsolute, relative, sep } from "node:path";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { z } from "zod";
import { autonomousAuthorityDefinitionSchema } from "./autonomous-authority.js";

/**
 * Child authority narrowing for mission delegation.
 *
 * A mission's authority envelope is the human-issued `AutonomousAuthorityDefinition` (migration 047). Delegated work
 * (a child work unit, a specialist, a swarm member) may only ever hold a subset of its parent's envelope, so a
 * requested definition is checked against the parent and refused if it is broader on ANY dimension. It is never
 * trimmed to fit: a request that asks for more than the parent has is a bug or an escalation attempt, and silently
 * shrinking it would hide that from the audit trail.
 *
 * This module is pure. It reads no store, issues no grant and mints no capability; a narrowed definition is only a
 * candidate that ACS must still persist and authorize through its own path.
 */
export type AutonomousAuthorityDefinition = z.infer<typeof autonomousAuthorityDefinitionSchema>;
type AuthorityResource = AutonomousAuthorityDefinition["scope"][number];

const FILESYSTEM_KINDS = new Set(["path", "repository"]);

/** True when `parent` grants at least everything `child` asks for on one resource. */
function resourceWithin(parent: AuthorityResource, child: AuthorityResource): boolean {
  if (parent.kind !== child.kind) return false;
  if (parent.id === child.id) return parent.coverage === "descendants" || child.coverage === "exact";
  if (parent.coverage !== "descendants" || !FILESYSTEM_KINDS.has(parent.kind)) return false;
  const suffix = relative(parent.id, child.id);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/**
 * Every way `child` is broader than `parent` at `now`, or an empty list when it is a subset. Malformed input is
 * reported as a violation too, so the caller can never mistake a parse failure for "no violations".
 */
export function authorityNarrowingViolations(parentInput: unknown, childInput: unknown, now: Date): string[] {
  const parent = autonomousAuthorityDefinitionSchema.safeParse(parentInput);
  if (!parent.success) return ["parent authority is not a valid definition"];
  const child = autonomousAuthorityDefinitionSchema.safeParse(childInput);
  if (!child.success) return ["child authority is not a valid definition"];
  const p = parent.data;
  const c = child.data;
  const violations: string[] = [];

  if (!(Date.parse(p.expiresAt) > now.getTime())) violations.push("parent authority has expired");
  if (Date.parse(c.expiresAt) > Date.parse(p.expiresAt)) violations.push("child outlives parent authority");
  if (c.executingActorId !== p.executingActorId) violations.push("child names a different executing actor");
  // An unpinned parent manifest allows any child manifest; a pinned parent must stay pinned to the same hash.
  if (p.manifestHash !== undefined && c.manifestHash !== p.manifestHash)
    violations.push("child does not keep the parent manifest binding");

  for (const resource of c.scope)
    if (!p.scope.some((allowed) => resourceWithin(allowed, resource)))
      violations.push(`scope ${resource.kind}:${resource.id} (${resource.coverage}) exceeds parent`);
  const parentTools = new Set(p.toolClasses.map((tool) => strictCanonicalJsonV1(tool)));
  for (const tool of c.toolClasses)
    if (!parentTools.has(strictCanonicalJsonV1(tool)))
      violations.push(`tool ${tool.runtime}:${tool.toolName} exceeds parent`);
  for (const privilege of c.maximumPrivileges)
    if (!p.maximumPrivileges.includes(privilege)) violations.push(`privilege ${privilege} exceeds parent`);
  for (const key of ["maxOperations", "maxRuntimeMs", "maxParallelOperations", "maxAttemptsPerOperation"] as const)
    if (c.limits[key] > p.limits[key]) violations.push(`limit ${key} exceeds parent`);

  return violations;
}

/** Fail-closed assertion form of {@link authorityNarrowingViolations}. */
export function assertAuthorityNarrowed(parent: unknown, child: unknown, now: Date): AutonomousAuthorityDefinition {
  const violations = authorityNarrowingViolations(parent, child, now);
  if (violations.length > 0)
    throw new ControlStackError(
      violations.includes("parent authority has expired") ? "authority_expired" : "authority_escalation",
      `Child authority is not a subset of its parent: ${violations.join("; ")}`
    );
  return autonomousAuthorityDefinitionSchema.parse(child);
}
