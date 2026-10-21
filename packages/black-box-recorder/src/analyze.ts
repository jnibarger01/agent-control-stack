import { canonicalJson, sha256Hex } from "./canonical.js";
import type {
  AuthState,
  Completeness,
  Finding,
  RecorderEvent,
  RunAnnotation,
  RunSummary,
  VerifyState,
} from "./types.js";
import type { RecorderStore } from "./store.js";

const AUTH_TYPES = new Set([
  "policy.evaluated",
  "authorization.allowed",
  "authorization.denied",
  "approval.granted",
  "approval.rejected",
]);

const EXEC_TYPES = new Set([
  "execution.started",
  "execution.completed",
  "execution.timed_out",
  "tool.started",
  "tool.completed",
  "tool.failed",
]);

const START_TYPES = new Set(["execution.started", "tool.started"]);
const END_TYPES = new Set([
  "execution.completed",
  "execution.timed_out",
  "tool.completed",
  "tool.failed",
  "mission.completed",
  "mission.failed",
  "agent.stopped",
  "agent.failed",
]);

const SUCCESS_TYPES = new Set(["execution.completed", "mission.completed", "tool.completed", "agent.stopped"]);

export function recomputeFindings(store: RecorderStore, observationWindowMs = 120_000): Finding[] {
  store.findings.length = 0;
  const byRun = group(store);
  for (const [runId, events] of byRun) {
    const annotation = store.annotations.get(runId) ?? {};
    store.findings.push(...rulesForRun(runId, events, annotation, store, observationWindowMs));
  }
  for (const conflict of store.conflicts) {
    const existing = store.events.get(conflict.existingEventId);
    const runId = existing?.runId ?? "unscoped";
    store.findings.push({
      findingId: `find_abbr.conflict_${conflict.existingEventId}`,
      ruleId: "abbr.conflict",
      ruleVersion: 1,
      severity: "high",
      scope: "evidence",
      runId,
      summary:
        "A second payload arrived with the same producer event identity and different content. The original record was kept.",
      relatedEventIds: [conflict.existingEventId],
      detectedAt: conflict.ingestedAt,
    });
  }
  return store.findings;
}

function rulesForRun(
  runId: string,
  events: RecorderEvent[],
  annotation: RunAnnotation,
  store: RecorderStore,
  observationWindowMs: number,
): Finding[] {
  const findings: Finding[] = [];
  const coverage = annotation.coverage ?? String(events[0]?.metadata.coverage ?? "unknown");
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

  const hasExec = events.some((event) => EXEC_TYPES.has(event.eventType));
  const hasAuth = events.some((event) => AUTH_TYPES.has(event.eventType));
  if (hasExec && !hasAuth && coverage !== "list-projection") {
    findings.push(
      finding(
        "abbr.missing-authorization",
        1,
        "high",
        "evidence",
        runId,
        "Execution evidence is present without a loaded authorization or approval record. That is uncorroborated. It is not proof the action was unauthorized.",
        ids.filter((id) => EXEC_TYPES.has(store.events.get(id)?.eventType ?? "")),
        detectedAt,
      ),
    );
  }

  const verifyFail = events.find((event) => event.eventType === "verification.failed");
  const verifyPass = events.find((event) => event.eventType === "verification.passed");
  const success = events.some((event) => isSuccessClaim(event));
  if (verifyFail) {
    findings.push(
      finding(
        "abbr.validator-failed",
        1,
        "high",
        "evidence",
        runId,
        "An independent verification failure is present. A producer success claim does not override it.",
        [verifyFail.eventId],
        detectedAt,
      ),
    );
  } else if (success && !verifyPass) {
    findings.push(
      finding(
        "abbr.unverified-success",
        1,
        coverage === "list-projection" ? "medium" : "high",
        coverage === "list-projection" ? "snapshot" : "evidence",
        runId,
        coverage === "list-projection"
          ? "The list row reports success. No validator record was loaded, so success stays unverified."
          : "A success or result-acceptance record is present and no verification.passed event is in the loaded chain. Exit success is not verification.",
        events.filter((event) => isSuccessClaim(event)).map((event) => event.eventId),
        detectedAt,
      ),
    );
  }

  const started = events.filter((event) => START_TYPES.has(event.eventType));
  const ended = events.some((event) => END_TYPES.has(event.eventType));
  if (started.length > 0 && !ended) {
    const newest = maxTime(started.map((event) => event.sourceTimestamp));
    const ingest = Date.parse(detectedAt);
    const age = newest ? ingest - Date.parse(newest) : observationWindowMs + 1;
    if (age > observationWindowMs) {
      findings.push(
        finding(
          "abbr.missing-terminal",
          1,
          "medium",
          "evidence",
          runId,
          "A start event has no terminal event inside the observation window. The run is incomplete, not failed.",
          started.map((event) => event.eventId),
          detectedAt,
        ),
      );
    }
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
        `ACS accepted the start. A later read (${annotation.correlatedWorkItem ?? "unknown work item"}) observed process exit ${annotation.correlatedExitCode} for session ${annotation.correlatedSession ?? "unknown"}. That exit is not a ResultValidator verdict, and spawn success is not process success.`,
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
    summaries.push(summarizeRun(runId, events, store));
  }
  summaries.sort((a, b) => (b.latestAt ?? "").localeCompare(a.latestAt ?? ""));
  return summaries;
}

export function summarizeRun(runId: string, events: RecorderEvent[], store: RecorderStore): RunSummary {
  const annotation = store.annotations.get(runId) ?? {};
  const findings = store.findings.filter((item) => item.runId === runId);
  const releases = unique(
    events.map((event) => event.source.releaseId).filter((id): id is string => Boolean(id)),
  );
  const startedAt = minTime(events.map((event) => event.sourceTimestamp));
  const latestAt = maxTime(events.map((event) => event.sourceTimestamp ?? event.ingestedAt));
  const terminal = events.find((event) => END_TYPES.has(event.eventType));
  const authEvent =
    events.find((event) => event.eventType === "authorization.denied" || event.eventType === "approval.rejected") ??
    events.find((event) => event.eventType === "approval.granted" || event.eventType === "authorization.allowed");
  const verifyEvent =
    events.find((event) => event.eventType === "verification.failed") ??
    events.find((event) => event.eventType === "verification.passed");
  const gapCount = findings.filter((item) => item.severity !== "info").length;
  const errorCount = findings.filter((item) => item.severity === "high").length;
  const completeness: Completeness = findings.some(
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
    tool: annotation.tool ?? String(events.find((event) => event.metadata.tool)?.metadata.tool ?? "unknown"),
    instruction: annotation.instruction ?? null,
    observedState: annotation.observedStatus ?? observedState(events),
    authorization: { state: authState(events, annotation.coverage), evidenceEventId: authEvent?.eventId ?? null },
    verification: {
      state: verifyState(events, annotation.coverage),
      evidenceEventId: verifyEvent?.eventId ?? null,
    },
    evidence: {
      completeness,
      eventCount: events.length,
      findingCount: findings.length,
      gapCount,
      errorCount,
    },
    sourceReleases: releases,
    coverage: annotation.coverage ?? "unknown",
    startedAt,
    latestAt,
    terminalAt: terminal?.sourceTimestamp ?? null,
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
      const byIngest = a.ingestedAt.localeCompare(b.ingestedAt);
      if (byIngest !== 0) return byIngest;
    }
    const at = a.sourceTimestamp ?? a.ingestedAt;
    const bt = b.sourceTimestamp ?? b.ingestedAt;
    const byTime = at.localeCompare(bt);
    if (byTime !== 0) return byTime;
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
    if (current.sourceTimestamp === previous.sourceTimestamp) return true;
    if (current.sourceTimestamp < previous.sourceTimestamp) return true;
  }
  return false;
}

export async function exportRun(store: RecorderStore, runId: string) {
  recomputeFindings(store);
  const events = orderEvents(store.eventsFor(runId), "source");
  const findings = store.findings.filter((item) => item.runId === runId);
  const summary = summarizeRun(runId, events, store);
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
  if (event.eventType === "verification.passed" || event.eventType === "verification.failed") return false;
  if (event.metadata.outcome === "succeeded") return true;
  if (SUCCESS_TYPES.has(event.eventType) && event.metadata.outcome !== "failed") {
    return event.eventType === "execution.completed" || event.eventType === "mission.completed";
  }
  return false;
}

function authState(events: RecorderEvent[], coverage?: string): AuthState {
  if (events.some((event) => event.eventType === "authorization.denied" || event.eventType === "approval.rejected")) {
    return "denied";
  }
  if (
    events.some(
      (event) =>
        event.eventType === "approval.granted" ||
        event.eventType === "authorization.allowed" ||
        event.eventType === "capability.issued",
    )
  ) {
    return "allowed";
  }
  if (
    events.some(
      (event) => event.metadata.policyDecision === "require_approval" || event.eventType === "approval.requested",
    )
  ) {
    return "held";
  }
  if (coverage === "list-projection") return "not_loaded";
  return "unknown";
}

function verifyState(events: RecorderEvent[], coverage?: string): VerifyState {
  if (events.some((event) => event.eventType === "verification.failed")) return "failed";
  if (events.some((event) => event.eventType === "verification.passed")) return "verified";
  if (events.some((event) => isSuccessClaim(event))) return "unverified";
  if (coverage === "list-projection") return "not_loaded";
  return "unknown";
}

function observedState(events: RecorderEvent[]): string {
  if (events.some((event) => event.eventType === "mission.failed" || event.eventType === "agent.failed")) return "failed";
  if (events.some((event) => event.eventType === "mission.completed")) return "completed";
  if (events.some((event) => event.eventType === "execution.completed")) return "completed";
  if (events.some((event) => START_TYPES.has(event.eventType))) return "running";
  return "observed";
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
    const runId = event.runId ?? "unscoped";
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
  return events.map((event) => event.ingestedAt).sort().at(-1) ?? new Date(0).toISOString();
}

function minTime(values: Array<string | null>): string | null {
  const finite = values.filter((value): value is string => Boolean(value)).sort();
  return finite[0] ?? null;
}

function maxTime(values: Array<string | null>): string | null {
  const finite = values.filter((value): value is string => Boolean(value)).sort();
  return finite.at(-1) ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
