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

export {
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  EXECUTION_RECEIPT_HASH_DOMAIN,
  executionReceiptCoreSchema,
  executionReceiptSchema,
  receiptBindingSchema,
  executionReceiptHash,
  receiptDefects,
  buildExecutionReceipt,
  verifyExecutionReceipt
} from "./execution-receipt.js";
export type { ExecutionReceipt, ExecutionReceiptCore, ReceiptBinding } from "./execution-receipt.js";

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

export {
  observationalIdentity,
  observationJobStatusSchema,
  OBSERVATION_OUTBOX_MAX_QUEUE,
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_TIMEOUT_MS,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  type ObservationOutboxEntry,
  type ObservationResult,
  type ObservationCapacity,
  type ObservationSkipReason
} from "./observation-outbox.js";

export {
  ObservationWorker,
  DEFAULT_CONFIG,
  type ObservationWorkerConfig,
  type ObservationWorkerState,
  type TraceClassifier
} from "./observation-worker.js";
