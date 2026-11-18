import { createHash } from "node:crypto";
import { FactoryIntentError, createFactoryProposal, type FactoryIntent } from "./plan.js";

/**
 * F1: authenticated, preview-only factory intake.
 *
 * This module is pure. It never reads the network, environment, filesystem or a database:
 * the caller injects the authenticated principal (from ACS credentials, never the body),
 * the intake policy, and a read-only repository reader. A preview admits nothing, creates
 * no mission, and grants nothing. Its hash is an equality token bound to the principal,
 * not a credential.
 */
export const FACTORY_PREVIEW_VERSION = "acs.ai-factory.preview.v1" as const;

export interface FactoryIntakePolicy {
  /** Opaque version string; it is bound into every preview hash so a policy change invalidates old previews. */
  readonly version: string;
  /** Explicit `owner/name` allowlist. Empty means every repository is refused. Compared case-insensitively. */
  readonly repositories: readonly string[];
  readonly maxLanes: number;
  readonly maxWallClockMs: number;
  readonly maxSpendMicrousd: number;
}

export type RepositoryResolution =
  | {
      readonly status: "resolved";
      /** Immutable numeric GitHub repository id; survives renames, unlike the name. */
      readonly repositoryId: number;
      /** Canonical `owner/name` as the host reports it. */
      readonly fullName: string;
      /** The full commit SHA the host resolved for the requested base. */
      readonly commitSha: string;
      readonly archived: boolean;
    }
  | { readonly status: "repository_not_found" | "commit_not_found" | "identity_drift" | "unavailable" };

/** Read-only. Implementations must never create, push, comment or otherwise write to the host. */
export interface FactoryRepositoryReader {
  resolve(repository: string, commitSha: string): Promise<RepositoryResolution>;
}

export type FactoryRefusalReason =
  | "invalid_principal"
  | "invalid_intent"
  | "repository_not_allowed"
  | "repository_not_found"
  | "repository_identity_drift"
  | "repository_archived"
  | "base_commit_not_found"
  | "base_ref_drift"
  | "repository_unavailable";

export interface FactoryPreviewRefusal {
  readonly schemaVersion: typeof FACTORY_PREVIEW_VERSION;
  readonly outcome: "refused";
  readonly reason: FactoryRefusalReason;
  readonly field?: string;
  readonly authority: "none";
  readonly admitted: false;
}

export interface FactoryPreviewConstraints {
  readonly maxLanes: number;
  readonly maxWallClockMs: number;
  readonly maxSpendMicrousd: number;
  /** Budget fields ACS reduced to the policy ceiling. ACS may reduce a request; it never widens one. */
  readonly reduced: readonly ("maxLanes" | "maxWallClockMs" | "maxSpendMicrousd")[];
}

export interface FactoryPreviewAccepted {
  readonly schemaVersion: typeof FACTORY_PREVIEW_VERSION;
  readonly outcome: "previewable";
  readonly previewHash: string;
  readonly principal: string;
  readonly orderId: string;
  readonly intentHash: string;
  readonly repository: Readonly<{ id: number; fullName: string }>;
  readonly baseSha: string;
  readonly policyVersion: string;
  readonly constraints: FactoryPreviewConstraints;
  readonly authority: "none";
  readonly admitted: false;
}

export type FactoryPreview = FactoryPreviewAccepted | FactoryPreviewRefusal;

const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;

function refuse(reason: FactoryRefusalReason, field?: string): FactoryPreviewRefusal {
  return {
    schemaVersion: FACTORY_PREVIEW_VERSION,
    outcome: "refused",
    reason,
    ...(field ? { field } : {}),
    authority: "none",
    admitted: false
  };
}

function constraintsFor(intent: FactoryIntent, policy: FactoryIntakePolicy): FactoryPreviewConstraints {
  const reduced: ("maxLanes" | "maxWallClockMs" | "maxSpendMicrousd")[] = [];
  const cap = (field: "maxLanes" | "maxWallClockMs" | "maxSpendMicrousd"): number => {
    const requested = intent.budget[field];
    const ceiling = policy[field];
    if (requested > ceiling) {
      reduced.push(field);
      return ceiling;
    }
    return requested;
  };
  return {
    maxLanes: cap("maxLanes"),
    maxWallClockMs: cap("maxWallClockMs"),
    maxSpendMicrousd: cap("maxSpendMicrousd"),
    reduced
  };
}

function assertPolicy(policy: FactoryIntakePolicy): void {
  for (const field of ["maxLanes", "maxWallClockMs", "maxSpendMicrousd"] as const) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) {
      throw new Error("factory intake policy " + field + " must be a non-negative safe integer");
    }
  }
  if (typeof policy.version !== "string" || policy.version.length === 0) {
    throw new Error("factory intake policy version is required");
  }
}

export function previewHashFor(input: {
  principal: string;
  intentHash: string;
  repositoryId: number;
  baseSha: string;
  policyVersion: string;
  constraints: FactoryPreviewConstraints;
}): string {
  return createHash("sha256")
    .update("acs:ai-factory-preview:v1\n", "utf8")
    .update(
      JSON.stringify([
        input.principal,
        input.intentHash,
        input.repositoryId,
        input.baseSha,
        input.policyVersion,
        input.constraints.maxLanes,
        input.constraints.maxWallClockMs,
        input.constraints.maxSpendMicrousd
      ]),
      "utf8"
    )
    .digest("hex");
}

export async function previewFactoryIntake(input: {
  /** Authenticated ACS actor id. Never taken from the request body. */
  principal: string;
  body: unknown;
  policy: FactoryIntakePolicy;
  reader: FactoryRepositoryReader;
}): Promise<FactoryPreview> {
  assertPolicy(input.policy);
  if (typeof input.principal !== "string" || !PRINCIPAL_PATTERN.test(input.principal)) {
    return refuse("invalid_principal");
  }
  let proposal: ReturnType<typeof createFactoryProposal>;
  try {
    proposal = createFactoryProposal(input.body);
  } catch (error) {
    if (error instanceof FactoryIntentError) return refuse("invalid_intent", error.field);
    throw error;
  }
  const { intent } = proposal;
  const requested = intent.repository.toLowerCase();
  // Allowlist first, so the reader is never used to probe repositories outside policy.
  if (!input.policy.repositories.some((repository) => repository.toLowerCase() === requested)) {
    return refuse("repository_not_allowed", "repository");
  }
  let resolution: RepositoryResolution;
  try {
    resolution = await input.reader.resolve(intent.repository, intent.baseSha);
  } catch {
    return refuse("repository_unavailable", "repository");
  }
  switch (resolution.status) {
    case "repository_not_found":
      return refuse("repository_not_found", "repository");
    case "identity_drift":
      return refuse("repository_identity_drift", "repository");
    case "commit_not_found":
      return refuse("base_commit_not_found", "baseSha");
    case "unavailable":
      return refuse("repository_unavailable", "repository");
    case "resolved":
      break;
    default:
      return refuse("repository_unavailable", "repository");
  }
  if (!Number.isSafeInteger(resolution.repositoryId) || resolution.repositoryId <= 0) {
    return refuse("repository_unavailable", "repository");
  }
  // A rename, transfer or redirect means the name no longer identifies what policy allowed.
  if (typeof resolution.fullName !== "string" || resolution.fullName.toLowerCase() !== requested) {
    return refuse("repository_identity_drift", "repository");
  }
  if (resolution.archived) return refuse("repository_archived", "repository");
  // Only an exact full-SHA echo counts; a prefix match or a different commit is drift.
  if (resolution.commitSha !== intent.baseSha) return refuse("base_ref_drift", "baseSha");
  const constraints = constraintsFor(intent, input.policy);
  const previewHash = previewHashFor({
    principal: input.principal,
    intentHash: proposal.intentHash,
    repositoryId: resolution.repositoryId,
    baseSha: intent.baseSha,
    policyVersion: input.policy.version,
    constraints
  });
  return {
    schemaVersion: FACTORY_PREVIEW_VERSION,
    outcome: "previewable",
    previewHash,
    principal: input.principal,
    orderId: intent.orderId,
    intentHash: proposal.intentHash,
    repository: { id: resolution.repositoryId, fullName: resolution.fullName },
    baseSha: intent.baseSha,
    policyVersion: input.policy.version,
    constraints,
    authority: "none",
    admitted: false
  };
}
