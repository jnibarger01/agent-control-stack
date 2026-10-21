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
export { containsSensitiveResidue, redact } from "./redact.js";
export { RecorderStore } from "./store.js";
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
