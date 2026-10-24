export const SCHEMA_VERSION = 1 as const;

export type TrustLevel =
  | "acs_authoritative"
  | "independently_verified"
  | "authenticated_producer"
  | "untrusted_claim"
  | "unknown";

export type IntegrityStatus = "valid" | "conflict" | "unverifiable";

export type RecorderEvent = {
  eventId: string;
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string | null;
  missionId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  eventType: string;
  source: {
    component: string;
    instanceId: string | null;
    releaseId: string | null;
    producerEventId: string | null;
    identityRef: string | null;
  };
  sourceTimestamp: string | null;
  ingestedAt: string;
  trustLevel: TrustLevel;
  metadata: Record<string, unknown>;
  evidence: {
    sourceRecordRef: string | null;
    payloadSha256: string;
    integrityStatus: IntegrityStatus;
  };
};

export type IngestDraft = {
  producerEventId: string;
  component: string;
  instanceId?: string | null;
  releaseId?: string | null;
  identityRef?: string | null;
  eventType: string;
  runId: string | null;
  missionId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  sourceTimestamp: string | null;
  ingestedAt: string;
  trustLevel: TrustLevel;
  metadata?: Record<string, unknown>;
  sourceRecordRef?: string | null;
};

export type FindingSeverity = "info" | "low" | "medium" | "high";

export type Finding = {
  findingId: string;
  ruleId: string;
  ruleVersion: number;
  severity: FindingSeverity;
  scope: "evidence" | "snapshot";
  runId: string;
  summary: string;
  relatedEventIds: string[];
  detectedAt: string;
};

export type AuthState = "allowed" | "denied" | "held" | "not_loaded" | "unknown";
export type VerifyState = "verified" | "failed" | "unverified" | "not_loaded" | "unknown";
export type Completeness = "complete" | "partial" | "unverifiable";

export type RunSummary = {
  runId: string;
  missionId: string | null;
  correlationId: string | null;
  agent: string;
  tool: string;
  instruction: string | null;
  observedState: string;
  authorization: { state: AuthState; evidenceEventId: string | null };
  verification: { state: VerifyState; evidenceEventId: string | null };
  evidence: {
    completeness: Completeness;
    eventCount: number;
    findingCount: number;
    gapCount: number;
    errorCount: number;
  };
  sourceReleases: string[];
  coverage: string;
  startedAt: string | null;
  latestAt: string | null;
  terminalAt: string | null;
};

export type RunAnnotation = {
  agent?: string;
  tool?: string;
  observedStatus?: string;
  coverage?: string;
  instruction?: string;
  correlatedExitCode?: number;
  correlatedSession?: string;
  correlatedWorkItem?: string;
  observedProcessExitCode?: number;
  sessionId?: string;
};

export type IngestResult =
  | { status: "created" | "duplicate"; event: RecorderEvent }
  | { status: "conflict"; event: RecorderEvent; rejectedSha256: string };
