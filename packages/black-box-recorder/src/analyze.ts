import { canonicalJson, sha256Hex } from "./canonical.js";
import type {
  Completeness,
  Finding,
  RecorderEvent,
  RunAnnotation,
  RunSummary,
} from "./types.js";
import { isPublicRecorderId, recorderRunId, type RecorderStore } from "./store.js";

const EXEC_TYPES = new Set([
  "execution.started",
  "execution.completed",
  "execution.timed_out",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "execution.tool_succeeded",
  "execution.tool_failed",
]);

const START_TYPES = new Set(["execution.started", "tool.started"]);
const END_TYPES = new Set([
  "execution.completed",
  "execution.timed_out",
  "tool.completed",
  "tool.failed",
  "execution.tool_succeeded",
  "execution.tool_failed",
  "mission.completed",
  "mission.failed",
  "agent.stopped",
  "agent.failed",
]);

const EXEC_SUCCESS_TYPES = new Set(["execution.completed", "tool.completed", "execution.tool_succeeded"]);
const SUCCESS_TYPES = new Set([...EXEC_SUCCESS_TYPES, "mission.completed", "agent.stopped"]);

export function recomputeFindings(store: RecorderStore, observationWindowMs = 120_000, observedAt = Date.now()): Finding[] {
  store.findings.length = 0;
  const byRun = group(store);
  for (const [runId, events] of byRun) {
    const annotation = store.annotationFor(runId) ?? {};
    store.findings.push(...rulesForRun(runId, events, annotation, store, observationWindowMs, observedAt));
  }
  const records = store.events;
  for (const [eventId, detectedAt] of store.conflictedAt) {
    const existing = records.get(eventId);
    const runId = recorderRunId(existing?.runId ?? null, eventId);
    store.findings.push({
      findingId: `find_abbr.conflict_${eventId}`,
      ruleId: "abbr.conflict",
      ruleVersion: 1,
      severity: "high",
      scope: "evidence",
      runId,
      summary:
        "A second payload arrived with the same producer event identity and different content. The original record was kept.",
      relatedEventIds: [eventId],
      detectedAt,
    });
  }
  return boundFindings(store);
}

/** Retained findings are capped. A cut is reported as a finding, never silently dropped. */
export const MAX_FINDINGS = 2000;

function boundFindings(store: RecorderStore): Finding[] {
  if (store.findings.length <= MAX_FINDINGS) return store.findings;
  const dropped = store.findings.length - MAX_FINDINGS;
  store.findings.length = MAX_FINDINGS;
  store.findings.push({
    findingId: "find_abbr.findings_truncated",
    ruleId: "abbr.findings_truncated",
    ruleVersion: 1,
    severity: "info",
    scope: "snapshot",
    runId: "unscoped",
    summary: `${dropped} finding(s) were not retained because the bound of ${MAX_FINDINGS} was reached.`,
    relatedEventIds: [],
    detectedAt: new Date(0).toISOString(),
  });
  return store.findings;
}

function rulesForRun(
  runId: string,
  events: RecorderEvent[],
  annotation: RunAnnotation,
  store: RecorderStore,
  observationWindowMs: number,
  observedAt: number,
): Finding[] {
  const findings: Finding[] = [];
  const coverage = runCoverage(annotation, events);
  const detectedAt = latestIngest(events);
  const ids = events.map((event) => event.eventId);

  if (coverage === "list-projection") {
    findings.push(
      finding(
        "abbr.snapshot-audit-unloaded",
        1,
        "info",
        "snapshot",
        runId,
        "Audit events were not loaded for this work item. The list row is not a reconstruction, and missing rows here are not missing rows in ACS.",
        ids.slice(0, 2),
        detectedAt,
      ),
    );
  }

  const executed = events.filter(isExecutionEvent);
  if (executed.length > 0 && authorizationEvidence(events, coverage, store).state !== "allowed" && coverage !== "list-projection") {
    findings.push(
      finding(
        "abbr.missing-authorization",
        1,
        "high",
        "evidence",
        runId,
        "Execution evidence is present without a matching trusted authorization or approval record.",
        executed.map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  const verification = verificationEvidence(events, coverage, store);
  if (verification.state === "failed" && verification.evidenceEventId) {
    findings.push(
      finding(
        "abbr.validator-failed",
        1,
        "high",
        "evidence",
        runId,
        "An independent verification failure is present. A producer success claim does not override it.",
        [verification.evidenceEventId],
        detectedAt,
      ),
    );
  } else if (verification.state === "unverified") {
    findings.push(
      finding(
        "abbr.unverified-success",
        1,
        coverage === "list-projection" ? "medium" : "high",
        coverage === "list-projection" ? "snapshot" : "evidence",
        runId,
        coverage === "list-projection"
          ? "The list row reports success. No validator record was loaded, so success stays unverified."
          : "One or more success claims lack trusted verification bound to the corresponding execution.",
        events.filter((event) => isSuccessClaim(event)).map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  const expired = unmatchedStarts(executed).filter((event) =>
    observedAt - epoch(event.sourceTimestamp ?? event.ingestedAt) > observationWindowMs);
  if (expired.length > 0) {
    findings.push(finding(
      "abbr.missing-terminal",
      1,
      "medium",
      "evidence",
      runId,
      "A recorded start has no matching terminal event after the observation window.",
      expired.map((event) => event.eventId),
      new Date(observedAt).toISOString(),
    ));
  }

  const releases = unique(
    events.map((event) => event.source.releaseId).filter((id): id is string => Boolean(id)),
  );
  if (releases.length > 1) {
    findings.push(
      finding(
        "abbr.release-mismatch",
        1,
        "medium",
        "evidence",
        runId,
        `More than one release identity is on this run: ${releases.join(", ")}.`,
        ids,
        detectedAt,
      ),
    );
  }
  if (coverage === "audit-chain" && (releases.length === 0 || releases.every((id) => id === "unreleased"))) {
    findings.push(
      finding(
        "abbr.release-unreleased",
        1,
        "info",
        "evidence",
        runId,
        releases[0] === "unreleased"
          ? "ACS recorded the release identity as the literal value unreleased. No release name was invented."
          : "No release identity was present. None was invented.",
        ids.slice(0, 1),
        detectedAt,
      ),
    );
  }
  if (coverage === "list-projection") {
    findings.push(
      finding(
        "abbr.release-not-in-snapshot",
        1,
        "info",
        "snapshot",
        runId,
        "Release identity was not on the work-item list row. It is unknown, not assumed.",
        ids.slice(0, 1),
        detectedAt,
      ),
    );
  }

  if (events.some((event) => event.sourceTimestamp && Date.parse(event.ingestedAt) + 1000 < Date.parse(event.sourceTimestamp))) {
    findings.push(
      finding(
        "abbr.clock-skew",
        1,
        "low",
        "evidence",
        runId,
        "An event was ingested before its source timestamp. Treat ordering as uncertain.",
        events
          .filter((event) => event.sourceTimestamp && Date.parse(event.ingestedAt) < Date.parse(event.sourceTimestamp))
          .map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  const ordered = [...events].sort(bySequence);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (!previous || !current) continue;
    const prev = Date.parse(previous.sourceTimestamp ?? "");
    const next = Date.parse(current.sourceTimestamp ?? "");
    if (Number.isFinite(prev) && Number.isFinite(next) && next + 1000 < prev) {
      findings.push(
        finding(
          "abbr.timestamp-uncertainty",
          1,
          "low",
          "evidence",
          runId,
          "Source timestamps go backwards relative to audit sequence. Order is uncertain.",
          [previous.eventId, current.eventId],
          detectedAt,
        ),
      );
      break;
    }
  }

  if (events.some((event) => event.metadata.chainLink === "broken")) {
    findings.push(
      finding(
        "abbr.audit-chain-break",
        1,
        "high",
        "evidence",
        runId,
        "An ACS audit previous-hash does not match the prior loaded event hash.",
        events.filter((event) => event.metadata.chainLink === "broken").map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  if (typeof annotation.correlatedExitCode === "number" && annotation.correlatedExitCode !== 0) {
    findings.push(
      finding(
        "abbr.spawn-accepted-process-exit",
        1,
        "high",
        "evidence",
        runId,
        `The recorded start was followed by a reported exit ${annotation.correlatedExitCode} for session ${annotation.correlatedSession ?? "unknown"} in ${annotation.correlatedWorkItem ?? "an unidentified work item"}. Independent verification is tracked separately.`,
        events.filter((event) => event.eventType === "execution.completed").map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  if (typeof annotation.observedProcessExitCode === "number" && annotation.observedProcessExitCode !== 0) {
    findings.push(
      finding(
        "abbr.process-exit-diverges",
        1,
        "high",
        "evidence",
        runId,
        `The work item outcome is the tool result. The observed process exit code is ${annotation.observedProcessExitCode} for session ${annotation.sessionId ?? "unknown"}. Output was withheld. These are different facts.`,
        events.filter((event) => event.metadata.observedProcessExitCode != null).map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  const unknown = events.filter(
    (event) =>
      event.trustLevel === "unknown" ||
      (event.trustLevel === "untrusted_claim" && !event.source.identityRef),
  );
  if (unknown.length > 0) {
    findings.push(
      finding(
        "abbr.unknown-producer",
        1,
        "medium",
        "evidence",
        runId,
        "At least one event has no authenticated producer identity. It stays an untrusted claim.",
        unknown.map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  return findings;
}

export function summarize(store: RecorderStore): RunSummary[] {
  recomputeFindings(store);
  const summaries: RunSummary[] = [];
  for (const [runId, events] of group(store)) {
    summaries.push(summarizeRecordedRun(runId, events, store));
  }
  summaries.sort((a, b) => epoch(b.latestAt) - epoch(a.latestAt));
  return summaries;
}

/** Select the complete evidence set from the store, including for legacy callers supplying an array. */
export function summarizeRun(runId: string, _events: RecorderEvent[], store: RecorderStore): RunSummary {
  recomputeFindings(store);
  return summarizeRecordedRun(runId, store.eventsFor(runId), store);
}

function summarizeRecordedRun(runId: string, events: RecorderEvent[], store: RecorderStore): RunSummary {
  const annotation = store.annotationFor(runId) ?? {};
  const coverage = runCoverage(annotation, events);
  const recordedTool = events.map((event) => event.metadata.tool).find((tool): tool is string => typeof tool === "string");
  const findings = store.findings.filter((item) => item.runId === runId);
  const releases = unique(
    events.map((event) => event.source.releaseId).filter((id): id is string => Boolean(id)),
  );
  const startedAt = minTime(events.map((event) => event.sourceTimestamp));
  const latestAt = maxTime(events.map((event) => event.sourceTimestamp ?? event.ingestedAt));
  const hasOpenAttempt = unmatchedStarts(events.filter(isExecutionEvent)).length > 0;
  const terminal = orderEvents(events.filter((event) => END_TYPES.has(event.eventType)), "source").at(-1);
  const gapCount = findings.filter((item) => item.severity !== "info").length;
  const errorCount = findings.filter((item) => item.severity === "high").length;
  const completeness: Completeness = events.length === 0 || events.some((event) => store.hasConflict(event.eventId)) || findings.some(
    (item) => item.ruleId === "abbr.conflict" || item.ruleId === "abbr.audit-chain-break",
  )
    ? "unverifiable"
    : gapCount > 0
      ? "partial"
      : "complete";

  return {
    runId,
    missionId: events.find((event) => event.missionId)?.missionId ?? null,
    correlationId: events.find((event) => event.correlationId)?.correlationId ?? null,
    agent: annotation.agent ?? "unknown",
    tool: annotation.tool ?? recordedTool ?? "unknown",
    instruction: annotation.instruction ?? null,
    observedState: annotation.observedStatus ?? observedState(hasOpenAttempt, terminal),
    authorization: authorizationEvidence(events, coverage, store),
    verification: verificationEvidence(events, coverage, store),
    evidence: {
      completeness,
      eventCount: events.length,
      findingCount: findings.length,
      gapCount,
      errorCount,
    },
    sourceReleases: releases,
    coverage,
    startedAt,
    latestAt,
    terminalAt: hasOpenAttempt ? null : terminal?.sourceTimestamp ?? null,
  };
}

export function queryRuns(
  store: RecorderStore,
  query: {
    limit?: number;
    cursor?: string | null;
    text?: string;
    authorization?: string;
    verification?: string;
    onlyGaps?: boolean;
    runId?: string;
    missionId?: string;
    correlationId?: string;
    eventType?: string;
    coverage?: string;
  },
) {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const offset = Number(query.cursor ?? "0");
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  let rows = summarize(store);
  const text = query.text?.trim().toLowerCase();
  if (text) {
    rows = rows.filter((row) =>
      [row.runId, row.missionId, row.correlationId, row.agent, row.tool, row.instruction]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(text)),
    );
  }
  if (query.authorization) rows = rows.filter((row) => row.authorization.state === query.authorization);
  if (query.verification) rows = rows.filter((row) => row.verification.state === query.verification);
  if (query.onlyGaps) rows = rows.filter((row) => row.evidence.gapCount > 0);
  if (query.runId) rows = rows.filter((row) => row.runId === query.runId);
  if (query.missionId) rows = rows.filter((row) => row.missionId === query.missionId);
  if (query.correlationId) rows = rows.filter((row) => row.correlationId === query.correlationId);
  if (query.eventType) {
    const wanted = query.eventType;
    rows = rows.filter((row) => store.eventsFor(row.runId).some((event) => event.eventType === wanted));
  }
  if (query.coverage) rows = rows.filter((row) => row.coverage === query.coverage);
  const page = rows.slice(start, start + limit);
  const next = start + limit < rows.length ? String(start + limit) : null;
  return { total: rows.length, runs: page, nextCursor: next };
}

export function orderEvents(events: RecorderEvent[], mode: "source" | "ingestion"): RecorderEvent[] {
  const copy = [...events];
  copy.sort((a, b) => {
    if (mode === "ingestion") {
      const byIngest = epoch(a.ingestedAt) - epoch(b.ingestedAt);
      if (byIngest) return byIngest;
    }
    const at = a.sourceTimestamp ?? a.ingestedAt;
    const bt = b.sourceTimestamp ?? b.ingestedAt;
    const byTime = epoch(at) - epoch(bt);
    if (byTime) return byTime;
    return sequenceOf(a) - sequenceOf(b);
  });
  return copy;
}

export function timestampUncertain(events: RecorderEvent[]): boolean {
  const ordered = [...events].sort(bySequence);
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i];
    const previous = ordered[i - 1];
    if (!current?.sourceTimestamp || !previous?.sourceTimestamp) continue;
    if (epoch(current.sourceTimestamp) <= epoch(previous.sourceTimestamp)) return true;
  }
  return false;
}

export async function exportRun(store: RecorderStore, runId: string) {
  const events = orderEvents(store.eventsFor(runId), "source");
  if (events.length === 0) throw new Error("Recorder run was not found");
  recomputeFindings(store);
  const findings = store.findings.filter((item) => item.runId === runId);
  const summary = summarizeRecordedRun(runId, events, store);
  const body = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    redaction: "allowlist-and-key-denylist",
    note: "Replay of recorded evidence. This bundle does not re-execute anything.",
    summary,
    events,
    findings,
  };
  const manifestSha256 = await sha256Hex(canonicalJson({ summary, events, findings }));
  return { ...body, manifest: { manifestSha256, eventCount: events.length, findingCount: findings.length } };
}

function isSuccessClaim(event: RecorderEvent): boolean {
  if (event.eventType.startsWith("verification.") || event.metadata.outcome === "failed") return false;
  return event.metadata.outcome === "succeeded" || SUCCESS_TYPES.has(event.eventType);
}

function runCoverage(annotation: RunAnnotation, events: RecorderEvent[]): string {
  const recorded = events[0]?.metadata.coverage;
  return annotation.coverage ?? (typeof recorded === "string" ? recorded : "unknown");
}

const TRUSTED_AUTHORITY = new Set(["acs_authoritative", "independently_verified"]);
const GRANT_TYPES = new Set(["approval.granted", "authorization.allowed", "capability.issued"]);
const DENIAL_TYPES = new Set(["authorization.denied", "approval.rejected"]);

function isExecutionEvent(event: RecorderEvent): boolean {
  return EXEC_TYPES.has(event.eventType);
}

function isAuthenticatedExecution(event: RecorderEvent): boolean {
  return isExecutionEvent(event) &&
    (TRUSTED_AUTHORITY.has(event.trustLevel) || event.trustLevel === "authenticated_producer");
}

function attemptKey(event: RecorderEvent): string | undefined {
  const attempt = event.metadata.attemptId;
  if (attempt !== undefined) return isPublicRecorderId(attempt) ? JSON.stringify(["attempt", attempt]) : undefined;
  const binding = authorizationBinding(event);
  if (binding) return JSON.stringify(["grant", binding]);
  const context = event.correlationId ?? event.source.component;
  if (isPublicRecorderId(context)) return JSON.stringify(["source", context, event.metadata.tool ?? null]);
}

function unmatchedStarts(events: RecorderEvent[]): RecorderEvent[] {
  const open: RecorderEvent[] = [];
  for (const event of orderEvents(events, "source")) {
    if (START_TYPES.has(event.eventType)) {
      open.push(event);
      continue;
    }
    if (!END_TYPES.has(event.eventType)) continue;
    const key = attemptKey(event);
    const index = open.findIndex((start) => {
      if (isAuthenticatedExecution(start) && !isAuthenticatedExecution(event)) return false;
      const sameContext = ["decisionId", "capabilityId", "actor", "actionHash"].every((field) => {
        const before = start.metadata[field];
        const after = event.metadata[field];
        return before === undefined || after === undefined || (isPublicRecorderId(before) && before === after);
      });
      if (!sameContext) return false;
      if (event.parentEventId) {
        if (!isPublicRecorderId(event.parentEventId)) return false;
        if (event.parentEventId === start.eventId) return true;
        return event.parentEventId === start.source.producerEventId &&
          event.source.component === start.source.component && event.source.instanceId === start.source.instanceId &&
          event.trustLevel === start.trustLevel;
      }
      return key !== undefined && attemptKey(start) === key;
    });
    if (index >= 0) open.splice(index, 1);
  }
  return open;
}

function authorizationBinding(event: RecorderEvent): string | undefined {
  const { decisionId, capabilityId, actor, actionHash } = event.metadata;
  const fields = [decisionId, capabilityId, actor, actionHash];
  if (fields.every(isPublicRecorderId)) {
    return JSON.stringify(fields);
  }
}

function authorizationEvidence(events: RecorderEvent[], coverage: string, store: RecorderStore): RunSummary["authorization"] {
  const executed = events.filter(isAuthenticatedExecution);
  const bindings = new Set(executed.map(authorizationBinding));
  const grants = new Map<string, { event: RecorderEvent; at: number }>();
  for (const event of events) {
    if (!TRUSTED_AUTHORITY.has(event.trustLevel) || store.hasConflict(event.eventId)) continue;
    const binding = authorizationBinding(event);
    if (DENIAL_TYPES.has(event.eventType) && (executed.length === 0 || (binding && bindings.has(binding)))) {
      return { state: "denied", evidenceEventId: event.eventId };
    }
    if (!binding || !GRANT_TYPES.has(event.eventType)) continue;
    const at = Date.parse(event.sourceTimestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const prior = grants.get(binding);
    if (!prior || at < prior.at) grants.set(binding, { event, at });
  }
  if (grants.size > 0) {
    let supportingGrant: RecorderEvent | undefined;
    for (const event of executed) {
      const binding = authorizationBinding(event);
      const grant = binding ? grants.get(binding) : undefined;
      const at = Date.parse(event.sourceTimestamp ?? "");
      if (store.hasConflict(event.eventId) || !grant || !Number.isFinite(at) || at < grant.at) {
        return { state: "unknown", evidenceEventId: null };
      }
      supportingGrant ??= grant.event;
    }
    supportingGrant ??= grants.values().next().value?.event;
    if (supportingGrant) return { state: "allowed", evidenceEventId: supportingGrant.eventId };
  }
  const held = events.find((event) => event.metadata.policyDecision === "require_approval" || event.eventType === "approval.requested");
  if (held) return { state: "held", evidenceEventId: held.eventId };
  return { state: coverage === "list-projection" ? "not_loaded" : "unknown", evidenceEventId: null };
}

function verificationEvidence(events: RecorderEvent[], coverage: string, store: RecorderStore): RunSummary["verification"] {
  const executed = new Map(events.filter(isAuthenticatedExecution).map((event) => [event.eventId, event]));
  const successes = [...executed.values()].filter(isSuccessClaim);
  const passes = new Map<string, RecorderEvent>();
  for (const event of events) {
    if (!TRUSTED_AUTHORITY.has(event.trustLevel) || store.hasConflict(event.eventId)) continue;
    const id = event.metadata.executionEventId;
    if (typeof id !== "string") continue;
    const target = executed.get(id);
    if (!target || !END_TYPES.has(target.eventType) || store.hasConflict(target.eventId)) continue;
    const executedAt = epoch(target.sourceTimestamp);
    const verifiedAt = epoch(event.sourceTimestamp);
    if (!Number.isFinite(executedAt) || !Number.isFinite(verifiedAt) || verifiedAt < executedAt) continue;
    const bindings = [
      [event.metadata.decisionId, target.metadata.decisionId],
      [event.metadata.capabilityId, target.metadata.capabilityId],
      [event.metadata.actionHash, target.metadata.actionHash],
      [event.metadata.executionActor, target.metadata.actor],
    ];
    if (!bindings.every(([claim, value]) => claim === undefined || (isPublicRecorderId(claim) && claim === value))) continue;
    if (event.eventType === "verification.failed") return { state: "failed", evidenceEventId: event.eventId };
    if (event.eventType === "verification.passed" && EXEC_SUCCESS_TYPES.has(target.eventType) && isSuccessClaim(target)) {
      passes.set(id, event);
    }
  }
  const conflictedExecution = [...executed.keys()].some((id) => store.hasConflict(id));
  if (!conflictedExecution && successes.length > 0 && successes.every((event) => passes.has(event.eventId))) {
    return { state: "verified", evidenceEventId: passes.values().next().value?.eventId ?? null };
  }
  if (events.some(isSuccessClaim)) return { state: "unverified", evidenceEventId: null };
  return { state: coverage === "list-projection" ? "not_loaded" : "unknown", evidenceEventId: null };
}

function observedState(hasOpenAttempt: boolean, terminal: RecorderEvent | undefined): string {
  if (hasOpenAttempt) return "running";
  if (!terminal) return "observed";
  if (terminal.metadata.outcome === "failed" || /(?:[._]failed|\.timed_out)$/.test(terminal.eventType)) return "failed";
  return "completed";
}

function finding(
  ruleId: string,
  ruleVersion: number,
  severity: Finding["severity"],
  scope: Finding["scope"],
  runId: string,
  summary: string,
  relatedEventIds: string[],
  detectedAt: string,
): Finding {
  return {
    findingId: `find_${ruleId}_${runId}`,
    ruleId,
    ruleVersion,
    severity,
    scope,
    runId,
    summary,
    relatedEventIds,
    detectedAt,
  };
}

function group(store: RecorderStore): Map<string, RecorderEvent[]> {
  const byRun = new Map<string, RecorderEvent[]>();
  for (const event of store.events.values()) {
    const runId = recorderRunId(event.runId, event.eventId);
    const list = byRun.get(runId) ?? [];
    list.push(event);
    byRun.set(runId, list);
  }
  return byRun;
}

function sequenceOf(event: RecorderEvent): number {
  return typeof event.metadata.sequence === "number" ? event.metadata.sequence : 0;
}

function bySequence(a: RecorderEvent, b: RecorderEvent): number {
  return sequenceOf(a) - sequenceOf(b);
}

function latestIngest(events: RecorderEvent[]): string {
  return maxTime(events.map((event) => event.ingestedAt)) ?? new Date(0).toISOString();
}

function epoch(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function minTime(values: Array<string | null>): string | null {
  const finite = values.filter((value): value is string => Number.isFinite(epoch(value))).sort((a, b) => epoch(a) - epoch(b));
  return finite[0] ?? null;
}

function maxTime(values: Array<string | null>): string | null {
  const finite = values.filter((value): value is string => Number.isFinite(epoch(value))).sort((a, b) => epoch(a) - epoch(b));
  return finite.at(-1) ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
