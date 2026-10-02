import { createHash } from "node:crypto";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { z } from "zod";
import { actionRequestSchema } from "./work-item.js";

export const CHANGE_SET_SCHEMA_VERSION = "acs.change-set.v1" as const;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true }).max(64);
const label = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
    "identifier contains a control character"
  );
const actorId = label.pipe(z.string().max(256));

export const changeSetResourceSchema = z
  .object({
    kind: z.enum(["repository", "path", "service", "environment", "network", "secret"]),
    id: label
  })
  .strict();

export const changeSetPrivilegeSchema = z.enum([
  "fs.read",
  "fs.write",
  "process.exec",
  "service.control",
  "deploy",
  "remote",
  "git.write",
  "secret.read",
  "network",
  "process.spawn",
  "process.read",
  "process.privileged",
  "git.read",
  "git.network",
  "integration.read",
  "integration.write"
]);

export const changeSetOperationSchema = z
  .object({
    operationId: id,
    runtime: z.enum(["jace_commander", "desktop_commander", "sandbox"]),
    toolName: id,
    // Proposal only: Policy Gate must derive risk and privileges from this exact
    // invocation, never trust the agent's requested privilege or effect labels.
    action: actionRequestSchema
      .extend({
        kind: z.string().min(1).max(128),
        description: z.string().min(1).max(4_000),
        params: z.record(z.string(), z.json())
      })
      .strict(),
    resources: z.array(changeSetResourceSchema).min(1).max(64),
    requestedPrivileges: z.array(changeSetPrivilegeSchema).min(1).max(16),
    effect: z.enum(["read_only", "mutation", "privileged"]),
    expectedSideEffects: z.array(label).max(64),
    dependsOn: z.array(id).max(128),
    retry: z.object({ maxAttempts: z.number().int().min(1).max(10), idempotencyKey: id }).strict()
  })
  .strict();

export const changeSetVerificationSchema = z
  .object({
    requirementId: id,
    operationIds: z.array(id).min(1).max(512),
    kind: z.enum([
      "command_exit",
      "tests",
      "typecheck",
      "lint",
      "db_readback",
      "http_probe",
      "service_state",
      "fs_inspect",
      "git_sha",
      "artifact_hash",
      "ci_status",
      "independent_review"
    ]),
    expectation: z
      .record(z.string(), z.json())
      .refine((value) => Object.keys(value).length > 0, "verification expectation must not be empty"),
    independent: z.boolean()
  })
  .strict();

export const changeSetDefinitionSchema = z
  .object({
    schemaVersion: z.literal(CHANGE_SET_SCHEMA_VERSION),
    missionId: id,
    subjectInputHash: hash,
    executingActorId: actorId,
    objective: z.string().min(1).max(8_000),
    scope: z.array(changeSetResourceSchema).min(1).max(512),
    maximumPrivileges: z.array(changeSetPrivilegeSchema).min(1).max(16),
    expiresAt: timestamp,
    constraints: z
      .object({
        maxRuntimeMs: z.number().int().min(1).max(86_400_000),
        maxParallelOperations: z.number().int().min(1).max(32),
        failureBehavior: z.enum(["stop", "continue_independent"])
      })
      .strict(),
    operations: z.array(changeSetOperationSchema).min(1).max(512),
    verification: z.array(changeSetVerificationSchema).max(512)
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string): void => context.addIssue({ code: "custom", message });
    if (Buffer.byteLength(strictCanonicalJsonV1(value), "utf8") > 1_048_576) issue("change set exceeds 1 MiB");
    const resourceKey = (resource: z.infer<typeof changeSetResourceSchema>): string => strictCanonicalJsonV1(resource);
    const scope = new Set(value.scope.map(resourceKey));
    if (scope.size !== value.scope.length) issue("scope resources must be unique");
    const privileges = new Set(value.maximumPrivileges);
    if (privileges.size !== value.maximumPrivileges.length) issue("maximum privileges must be unique");
    const operations = new Map(value.operations.map((operation) => [operation.operationId, operation]));
    if (operations.size !== value.operations.length) issue("operation identifiers must be unique");
    const retryKeys = new Set(value.operations.map((operation) => operation.retry.idempotencyKey));
    if (retryKeys.size !== value.operations.length) issue("operation idempotency keys must be unique");
    for (const operation of value.operations) {
      if (operation.resources.some((resource) => !scope.has(resourceKey(resource))))
        issue("operation resource outside change set scope");
      if (operation.requestedPrivileges.some((privilege) => !privileges.has(privilege)))
        issue("operation privilege outside change set maximum");
      if (new Set(operation.dependsOn).size !== operation.dependsOn.length) issue("dependencies must be unique");
      if (operation.dependsOn.some((dependency) => !operations.has(dependency))) issue("unknown operation dependency");
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (operationId: string): boolean => {
      if (visiting.has(operationId)) return false;
      if (visited.has(operationId)) return true;
      visiting.add(operationId);
      for (const dependency of operations.get(operationId)?.dependsOn ?? []) {
        if (!visit(dependency)) return false;
      }
      visiting.delete(operationId);
      visited.add(operationId);
      return true;
    };
    if ([...operations.keys()].some((operationId) => !visit(operationId))) issue("operation dependency cycle");
    if (
      new Set(value.verification.map((requirement) => requirement.requirementId)).size !== value.verification.length
    ) {
      issue("verification identifiers must be unique");
    }
    for (const requirement of value.verification) {
      if (requirement.operationIds.some((operationId) => !operations.has(operationId)))
        issue("verification references unknown operation");
      if (requirement.kind === "independent_review" && !requirement.independent)
        issue("independent review must be independent");
    }
    for (const operation of value.operations) {
      const requirements = value.verification.filter((requirement) =>
        requirement.operationIds.includes(operation.operationId)
      );
      if (
        operation.effect !== "read_only" &&
        !requirements.some((requirement) => requirement.kind !== "independent_review")
      ) {
        issue("mutation requires machine verification");
      }
      if (
        operation.effect === "privileged" &&
        !requirements.some((requirement) => requirement.kind === "independent_review")
      ) {
        issue("privileged operation requires independent review");
      }
    }
  });

export const changeSetSnapshotSchema = z
  .object({
    revision: z.number().int().positive(),
    parentManifestHash: hash.nullable(),
    definition: changeSetDefinitionSchema
  })
  .strict();

export const changeSetRecordSchema = z
  .object({
    snapshot: changeSetSnapshotSchema,
    manifestHash: hash,
    auditEventId: id,
    submissionId: id,
    createdByActorId: actorId,
    createdAt: timestamp
  })
  .strict();

export const submitChangeSetInputSchema = z
  .object({
    definition: changeSetDefinitionSchema,
    expectedHeadHash: hash.nullable(),
    submissionId: id,
    createdByActorId: actorId,
    now: z.date().optional()
  })
  .strict();

export type ChangeSetDefinition = z.infer<typeof changeSetDefinitionSchema>;
export type ChangeSetSnapshot = z.infer<typeof changeSetSnapshotSchema>;
export type ChangeSetRecord = z.infer<typeof changeSetRecordSchema>;
export type SubmitChangeSetInput = z.infer<typeof submitChangeSetInputSchema>;

/** Hash every snapshot field, including operation identity, expiration and evidence. */
export function changeSetManifestHash(input: unknown): string {
  // Reject non-JSON input before Zod can normalize away unsupported properties.
  strictCanonicalJsonV1(input);
  const snapshot = changeSetSnapshotSchema.parse(input);
  return createHash("sha256")
    .update("acs.change-set.manifest.v1\0")
    .update(strictCanonicalJsonV1(snapshot))
    .digest("hex");
}
