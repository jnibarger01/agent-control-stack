/**
 * @agent-control-stack/evidence
 *
 * ACS-owned machine evidence (ADR 0015). This package assembles
 * `EVIDENCE_AUTHORITY` facts into a content-addressed `EvidenceManifest`,
 * computes workspace revisions for TOCTOU binding, and exposes an
 * attempt-scoped READ-ONLY evidence surface.
 *
 * It owns no durable authority state and has no capability to write, execute,
 * approve, or transition anything. A model-generated summary is never an
 * `Observation` and is never a manifest field.
 */

export { evidenceSourceSchema, observationSchema, observation } from "./observation.js";
export type { EvidenceSource, Observation } from "./observation.js";

export {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_MANIFEST_HASH_DOMAIN,
  evidenceManifestSchema,
  executedCommandEvidenceSchema,
  testEvidenceSchema,
  evidenceManifestHash,
  buildEvidenceManifest,
  verifyEvidenceManifestHash
} from "./evidence-manifest.js";
export type {
  EvidenceManifest,
  ExecutedCommandEvidence,
  TestEvidence,
  BuildEvidenceManifestInput
} from "./evidence-manifest.js";

export { computeWorkspaceRevision, detectWorkspaceDrift } from "./workspace-revision.js";
export type { WorkspaceRevisionResult, WorkspaceDriftResult } from "./workspace-revision.js";

export {
  EVIDENCE_READ_CAPABILITIES,
  FORBIDDEN_CAPABILITY_PATTERNS,
  assertNoForbiddenCapability
} from "./read-surface.js";
export type {
  EvidenceReadCapability,
  EvidenceReadSurface,
  ForbiddenCapabilityViolation,
  ReadFileInput,
  ListDirectoryInput,
  SearchWorkspaceInput,
  AuditExcerptInput
} from "./read-surface.js";

export { EvidenceReader } from "./reader.js";
export type { EvidenceReaderContext, EvidenceStoreReader } from "./reader.js";
