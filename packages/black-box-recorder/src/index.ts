/**
 * @agent-control-stack/black-box-recorder
 *
 * In-memory Agent Black Box recorder. It normalizes, redacts, hashes, and
 * correlates evidence. It has no execution, approval, capability, or dispatch
 * authority, and it does not write the ACS database.
 *
 * The bundled snapshot is a redacted point-in-time read. It is not a live
 * gateway connection. Fixture runs are labeled nonproduction data.
 */

export { SCHEMA_VERSION } from "./types.js";
export type {
  AuthState,
  ChainFinding,
  ChainFindingKind,
  ChainVerification,
  Completeness,
  Finding,
  FindingSeverity,
  IngestDraft,
  IngestResult,
  IntegrityStatus,
  RecorderEvent,
  RunAnnotation,
  RunSummary,
  TrustLevel,
  VerifyState
} from "./types.js";
export { canonicalJson, envelopeForDigest, sha256Hex } from "./canonical.js";
export { containsSensitiveResidue, redact, redactField } from "./redact.js";
export {
  GENESIS_HASH,
  RecorderStore,
  computeEventHash,
  computeRecorderFingerprint,
  recorderEventIdFor,
  verifyRecorderChain,
  type PreparedRecorderDraft,
  type RecorderStoreOptions
} from "./store.js";
export {
  ObserverKeyRegistry,
  computeSpkiFingerprintSha256,
  validatePublicKeyCustody,
  type KeyEvaluationResult,
  type ObserverKeyRecord,
  type ObserverKeyStatus
} from "./key-lifecycle.js";
export {
  JC_KERNEL_WITNESS_SCHEMA_VERSION,
  JC_KERNEL_WITNESS_SCHEMA_VERSION_V1,
  JC_KERNEL_WITNESS_SCHEMA_VERSION_V2,
  computeV2CategoryDigests,
  computeWitnessEvidenceHash,
  ingestJcWitnessReceipt,
  isJcKernelWitnessReceipt,
  isJcKernelWitnessReceiptV1,
  isJcKernelWitnessReceiptV2,
  resolveReceiptWallClockTimestamp,
  toWitnessRecorderDraft,
  verifyJcWitnessReceipt,
  witnessCanonicalBody,
  witnessSigningPayload,
  type JcKernelWitnessReceipt,
  type JcKernelWitnessReceiptV1,
  type JcKernelWitnessReceiptV2,
  type JcWitnessCategory,
  type JcWitnessCategoryCompletenessMap,
  type JcWitnessCategoryStatus,
  type JcWitnessFilesystemEvent,
  type JcWitnessFilesystemOp,
  type JcWitnessKernelEvent,
  type JcWitnessNetworkEvent,
  type JcWitnessNetworkOutcome,
  type JcWitnessObservationScope,
  type JcWitnessProcessNode,
  type VerifyJcWitnessOptions,
  type WitnessIngestResult,
  type WitnessVerificationResult
} from "./jc-witness-adapter.js";
export {
  ImmutableFsWormSink,
  S3ObjectLockWormSink,
  WormTamperOrConflictError,
  canonicalWormEnvelopeIdentity,
  createS3ObjectLockTestHandler,
  verifyWormEnvelopeSequence,
  verifyWormReceiptEnvelope,
  type ImmutableFsWormSinkOptions,
  type S3ObjectLockWormSinkOptions,
  type WormChainHeadAnchor,
  type WormEvidenceSink,
  type WormIntegrityFinding,
  type WormIntegrityFindingKind,
  type WormIntegrityReport,
  type WormPutResult,
  type WormReceiptEnvelope
} from "./worm-sink.js";
export {
  exportRun,
  orderEvents,
  queryRuns,
  recomputeFindings,
  summarize,
  summarizeRun,
  timestampUncertain
} from "./analyze.js";
export { FIXTURE_RUNS } from "./fixture.js";
export { LIVE_FOCUS_RUN, capture, loadLane } from "./load.js";
export { recorderFeatureEnabled } from "./flag.js";
export { toRecorderDraft, type AcsExecutionRow } from "./acs-emitter.js";
// signRecordDraft is intentionally NOT exported: it holds key handling and must stay out of the browser bundle.
