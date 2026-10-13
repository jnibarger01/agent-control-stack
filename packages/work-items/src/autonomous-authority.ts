import { isAbsolute, relative, resolve, sep } from "node:path";
import { ControlStackError, stableHash, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { z } from "zod";
import { changeSetPrivilegeSchema, changeSetResourceSchema, type ChangeSetRecord } from "./change-set.js";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
export const authorityResourceSchema = changeSetResourceSchema
  .extend({
    coverage: z.enum(["exact", "descendants"])
  })
  .strict()
  .superRefine((resource, context) => {
    const filesystem = resource.kind === "path" || resource.kind === "repository";
    if (filesystem && (!isAbsolute(resource.id) || resolve(resource.id) !== resource.id))
      context.addIssue({ code: "custom", message: "filesystem grant resources must be canonical absolute paths" });
    if (!filesystem && resource.coverage !== "exact")
      context.addIssue({ code: "custom", message: "only filesystem resources support descendant scope" });
  });
/** An exact http(s) origin: scheme, host and optional port only, no path, credentials, wildcard or trailing slash. */
const exactOrigin = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    if (/[\s*\\]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, "must be an exact http(s) origin");
const uniqueList = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .min(1)
    .max(max)
    .refine((values) => new Set(values).size === values.length, "must be unique");
export const commanderToolClassSchema = z
  .object({
    runtime: z.enum(["desktop_commander", "jace_commander", "sandbox"]),
    toolName: id
  })
  .strict();
/**
 * The browser runtime (the cua lane). A grant names the exact origins and applications it covers; a dispatch is only
 * authorized when its whole origin and application allowlist is inside one browser grant. Nothing is implied by the
 * runtime alone, so an empty or wildcard scope cannot be expressed.
 */
export const browserToolClassSchema = z
  .object({
    runtime: z.literal("browser"),
    toolName: z.literal("cua"),
    allowedOrigins: uniqueList(exactOrigin, 64),
    allowedApplications: uniqueList(id, 64)
  })
  .strict();
export type AuthorityToolClass = z.infer<typeof commanderToolClassSchema> | z.infer<typeof browserToolClassSchema>;
export const autonomousAuthorityDefinitionSchema = z
  .object({
    executingActorId: id,
    scope: z.array(authorityResourceSchema).min(1).max(512),
    toolClasses: z
      .array(z.union([commanderToolClassSchema, browserToolClassSchema]))
      .min(1)
      .max(512),
    maximumPrivileges: z.array(changeSetPrivilegeSchema).min(1).max(16),
    expiresAt: timestamp,
    manifestHash: hash.optional(),
    limits: z
      .object({
        maxOperations: z.number().int().min(1).max(4096),
        maxRuntimeMs: z.number().int().min(1).max(86_400_000),
        maxParallelOperations: z.number().int().min(1).max(32),
        maxAttemptsPerOperation: z.number().int().min(1).max(10)
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    for (const [name, values] of [
      ["scope", value.scope.map((r) => strictCanonicalJsonV1({ kind: r.kind, id: r.id }))],
      ["toolClasses", value.toolClasses.map(strictCanonicalJsonV1)],
      ["maximumPrivileges", value.maximumPrivileges]
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", message: `${name} must be unique` });
  });
export const issueAutonomousAuthorityBodySchema = z
  .object({
    requestId: id,
    expectedSubjectInputHash: hash,
    definition: autonomousAuthorityDefinitionSchema,
    reason: z.string().min(1).max(4000)
  })
  .strict();
export const autonomousAuthorityCoreSchema = z
  .object({
    schemaVersion: z.literal("acs.autonomous-authority.v1"),
    grantId: id,
    missionId: id,
    subjectInputHash: hash,
    issuedByActorId: id,
    requestId: id,
    definition: autonomousAuthorityDefinitionSchema,
    reason: z.string().min(1).max(4000),
    createdAt: timestamp
  })
  .strict();
export const autonomousAuthoritySchema = autonomousAuthorityCoreSchema
  .extend({ grantHash: hash, auditEventId: id })
  .strict();
export type AutonomousAuthorityGrant = z.infer<typeof autonomousAuthoritySchema>;
export type IssueAutonomousAuthorityInput = z.infer<typeof issueAutonomousAuthorityBodySchema> & {
  missionId: string;
  issuedByActorId: string;
};
export function autonomousAuthorityHash(input: unknown): string {
  return stableHash({ domain: "acs.autonomous-authority.v1", record: autonomousAuthorityCoreSchema.parse(input) });
}

/** Check untrusted plan declarations; canonical runtime policy must also validate them. */
export function assertChangeSetWithinGrant(grant: AutonomousAuthorityGrant, record: ChangeSetRecord): void {
  const definition = record.snapshot.definition;
  const authority = grant.definition;
  const covered = (resource: z.infer<typeof changeSetResourceSchema>) =>
    authority.scope.some((allowed) => {
      if (allowed.kind !== resource.kind) return false;
      if (allowed.id === resource.id) return true;
      if (allowed.coverage !== "descendants" || !isAbsolute(resource.id) || resolve(resource.id) !== resource.id)
        return false;
      const suffix = relative(allowed.id, resource.id);
      return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    });
  if (
    grant.missionId !== definition.missionId ||
    grant.subjectInputHash !== definition.subjectInputHash ||
    authority.executingActorId !== definition.executingActorId ||
    (authority.manifestHash !== undefined && authority.manifestHash !== record.manifestHash) ||
    Date.parse(definition.expiresAt) > Date.parse(authority.expiresAt) ||
    definition.scope.some((resource) => !covered(resource)) ||
    definition.maximumPrivileges.some((privilege) => !authority.maximumPrivileges.includes(privilege)) ||
    definition.operations.length > authority.limits.maxOperations ||
    definition.constraints.maxRuntimeMs > authority.limits.maxRuntimeMs ||
    definition.constraints.maxParallelOperations > authority.limits.maxParallelOperations ||
    definition.operations.some(
      (operation) =>
        !authority.toolClasses.some(
          (tool) => tool.runtime === operation.runtime && tool.toolName === operation.toolName
        ) ||
        operation.resources.some((resource) => !covered(resource)) ||
        operation.requestedPrivileges.some((privilege) => !authority.maximumPrivileges.includes(privilege)) ||
        operation.retry.maxAttempts > authority.limits.maxAttemptsPerOperation
    )
  )
    throw new ControlStackError("autonomous_authority_scope_mismatch", "Change Set exceeds human-issued authority");
}

export const grantAuthorizationCoreSchema = z
  .object({
    schemaVersion: z.literal("acs.change-set.grant-authorization.v1"),
    authorizationId: id,
    grantId: id,
    grantHash: hash,
    missionId: id,
    revision: z.number().int().positive(),
    manifestHash: hash,
    subjectInputHash: hash,
    executingActorId: id,
    policyHash: hash,
    policyAuditEventId: id,
    createdAt: timestamp,
    expiresAt: timestamp
  })
  .strict();
export const grantAuthorizationSchema = grantAuthorizationCoreSchema
  .extend({
    authorizationHash: hash,
    auditEventId: id
  })
  .strict();
export type GrantAuthorization = z.infer<typeof grantAuthorizationSchema>;
export interface ChangeSetExecutionAuthority {
  authorityId: string;
  authorityKind: "human_approval" | "autonomous_grant";
  missionId: string;
  revision: number;
  manifestHash: string;
  executingActorId: string;
  humanIssuerActorId: string;
  policyActorId: string;
  policyHash: string;
  policyAuditEventId: string;
  expiresAt: string;
  grant?: AutonomousAuthorityGrant;
}
export function grantAuthorizationHash(input: unknown): string {
  return stableHash({
    domain: "acs.change-set.grant-authorization.v1",
    record: grantAuthorizationCoreSchema.parse(input)
  });
}
