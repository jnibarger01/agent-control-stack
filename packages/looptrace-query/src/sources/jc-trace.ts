import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyJcLocalTrace, type JcLocalTraceEvent } from "@agent-control-stack/desktop-commander-adapter";
import {
  EVIDENCE_SCHEMA_VERSION,
  contentHash,
  eventId,
  normalizeTimestamp,
  stageOf,
  type EvidenceEvent,
  type EventType
} from "../model.js";
import { sanitizeText, sanitizeUntrusted } from "../sanitize.js";

/**
 * Read-only Jace Commander (JC) local-trace reader.
 *
 * Real format (vendor/desktop-commander/src/jace-commander/{server,looptrace}.ts): one file per MCP server PROCESS,
 * `<stateDir>/traces/jc-mcp-<pid>-<epoch_ms>.jsonl`, one `{run_id,seq,ts,type,payload,redacted,prev_hash,hash}` object per
 * line. `run_id` therefore identifies a process SESSION that serves many ACS work items; it is not an ACS execution. The
 * chain rule is `hash = sha256(prev_hash + "\n" + canonical(event without hash))` from a 64-zero genesis; it is shared with
 * `verifyJcLocalTrace`, and both were checked against every real trace on the build host.
 *
 * What a real trace contains: `tool_call_finished` carrying `{tool, argumentsSha256, ok, workItemId?, code?}` (the work
 * item id comes from the ACS-issued authorization for that call). `tool_call_started` (no work item id) is written only
 * for locally-authorized mutating calls. JC never writes run_completed/run_failed/trace_sealed, so none is required.
 *
 * Three separate levels of evidence, never conflated:
 *   1. session integrity    - `jc.session`: did this process's whole chain verify (and what could not be attributed)?
 *   2. tool-call outcome    - `jc.tool.finished`: JC's own `ok`/`code` for one call that ACS authorized for this work item.
 *   3. work-item completion - NEVER taken from JC. A successful tool call does not show the mission succeeded.
 *
 * Trust: every event is `asserted` (the executor's own record; a valid chain proves it was not edited, not that effects
 * occurred or that the file is complete). They use the lifecycle stage so they can never satisfy a required ACS stage.
 *
 * Safety: roots are operator-configured; callers never supply paths. Symlinks and non-regular files are not read, file
 * count / size / event count are bounded, payloads are sanitized and kept inert. Anything skipped, unparseable, broken or
 * out of bounds is reported (as `jc.session` / `jc.coverage` events), never silently dropped.
 */

export const JC_LIMITS = { maxFiles: 300, maxFileBytes: 2_000_000, maxEvents: 5_000 } as const;

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.jsonl$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_RE = /^[a-f0-9]{64}$/u;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;

export interface JcReadResult {
  events: EvidenceEvent[];
  status: "ok" | "unavailable";
  detail: string;
  /** Sessions (trace files) that name the work item. */
  runs: number;
}

type Parsed = { kind: "ok"; runId: string; events: JcLocalTraceEvent[] } | { kind: "malformed"; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSession(text: string): Parsed {
  const events: JcLocalTraceEvent[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/u)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    if (events.length >= JC_LIMITS.maxEvents) return { kind: "malformed", reason: "over_event_bound" };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { kind: "malformed", reason: `invalid_json_line_${lineNo}` };
    }
    if (!isRecord(value)) return { kind: "malformed", reason: `non_object_line_${lineNo}` };
    const { run_id, seq, ts, type, payload, redacted, prev_hash, hash } = value;
    if (
      typeof run_id !== "string" ||
      typeof seq !== "number" ||
      typeof ts !== "string" ||
      typeof type !== "string" ||
      !isRecord(payload) ||
      typeof redacted !== "boolean" ||
      typeof prev_hash !== "string" ||
      typeof hash !== "string"
    ) {
      return { kind: "malformed", reason: `bad_event_shape_line_${lineNo}` };
    }
    events.push({ run_id, seq, ts, type: type as JcLocalTraceEvent["type"], payload, redacted, prev_hash, hash });
  }
  const first = events[0];
  return first ? { kind: "ok", runId: first.run_id, events } : { kind: "malformed", reason: "empty_trace" };
}

/** The ACS work item named by a real JC event: `payload.workItemId` (camelCase). Invalid values are not coerced. */
function workItemOf(e: JcLocalTraceEvent): { id: string | null; present: boolean } {
  const w = e.payload.workItemId;
  if (w === undefined || w === null) return { id: null, present: false };
  return typeof w === "string" && ID_RE.test(w) ? { id: w, present: true } : { id: null, present: true };
}

function str(v: unknown, max = 160): string | null {
  return typeof v === "string" && v.length > 0 ? sanitizeText(v, max).text : null;
}

interface Coverage {
  rootsUnreadable: number;
  rootsTotal: number;
  filesBeyondBound: number;
  filesSkipped: number;
  filesUnreadable: number;
}

export class JcTraceReader {
  constructor(
    private readonly roots: readonly string[],
    private readonly now: () => Date
  ) {}

  /** Finds JC sessions that name `workItemId` and converts the matching events (plus session integrity) to evidence. */
  collect(workItemId: string): JcReadResult {
    const out: EvidenceEvent[] = [];
    const cov: Coverage = { rootsUnreadable: 0, rootsTotal: this.roots.length, filesBeyondBound: 0, filesSkipped: 0, filesUnreadable: 0 };
    let sessions = 0;
    for (const root of this.roots) {
      let names: string[];
      try {
        const st = lstatSync(root);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("not a plain directory");
        const all = readdirSync(root).filter((n) => FILE_RE.test(n)).sort();
        cov.filesBeyondBound += Math.max(0, all.length - JC_LIMITS.maxFiles);
        names = all.slice(0, JC_LIMITS.maxFiles);
      } catch {
        cov.rootsUnreadable += 1;
        continue;
      }
      for (const name of names) {
        const path = join(root, name);
        let text: string;
        try {
          const st = lstatSync(path);
          if (!st.isFile() || st.isSymbolicLink() || st.size > JC_LIMITS.maxFileBytes) {
            cov.filesSkipped += 1; // cannot be checked for this work item: reported, not ignored
            continue;
          }
          text = readFileSync(path, "utf8");
        } catch {
          cov.filesUnreadable += 1;
          continue;
        }
        if (!text.includes(workItemId)) continue; // cheap pre-filter before parsing
        const stem = name.slice(0, -".jsonl".length);
        const parsed = parseSession(text);
        if (parsed.kind === "malformed") {
          // The file names the work item but cannot be used: surface it as unverifiable evidence.
          sessions += 1;
          out.push(this.malformedEvent(workItemId, stem, parsed.reason));
          continue;
        }
        const matching = parsed.events.filter((e) => workItemOf(e).id === workItemId);
        if (matching.length === 0) continue; // the id only appeared inside some other field
        sessions += 1;
        out.push(...this.toEvidence(parsed.runId, parsed.events, matching, workItemId));
      }
    }

    if (this.roots.length > 0 && cov.rootsUnreadable === this.roots.length) {
      return { events: [], status: "unavailable", detail: "no configured JC trace root could be read", runs: 0 };
    }
    const incomplete = cov.rootsUnreadable + cov.filesBeyondBound + cov.filesSkipped + cov.filesUnreadable > 0;
    if (incomplete) out.push(this.coverageEvent(workItemId, cov));
    const notes: string[] = [];
    if (cov.rootsUnreadable > 0) notes.push(`${cov.rootsUnreadable}/${cov.rootsTotal} JC root(s) unreadable`);
    if (cov.filesBeyondBound > 0) notes.push(`${cov.filesBeyondBound} trace file(s) beyond the scan bound not read`);
    if (cov.filesSkipped > 0) notes.push(`${cov.filesSkipped} file(s) skipped (oversize/not a plain file)`);
    if (cov.filesUnreadable > 0) notes.push(`${cov.filesUnreadable} file(s) unreadable`);
    return { events: out, status: "ok", detail: notes.join("; "), runs: sessions };
  }

  private base(workItemId: string) {
    return {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      trace_id: null,
      request_id: null,
      work_item_id: workItemId,
      span_id: null,
      parent_span_id: null,
      observed_at: this.now().toISOString(),
      actor: { id: "jace-commander", type: "system" as const },
      source: { system: "jace_commander", component: "local-trace", instance: null },
      decision: null,
      capability_id: null,
      release_sha: null,
      causes: [] as string[],
      refs: {} as Record<string, string>,
      untrusted: {} as Record<string, unknown>,
      tool_name: null as string | null
    };
  }

  private seal<T extends { integrity: { content_hash: string } }>(body: T): T {
    body.integrity.content_hash = contentHash({ ...body, observed_at: undefined });
    return body;
  }

  /** The file names the work item but could not be parsed or bounded: unverifiable evidence, reported as such. */
  private malformedEvent(workItemId: string, sessionStem: string, reason: string): EvidenceEvent {
    const safe = ID_RE.test(sessionStem) ? sessionStem : "invalid-session-id";
    return this.seal({
      ...this.base(workItemId),
      event_id: eventId("jc", `${safe}.session`),
      timestamp: null,
      event_type: "jc.session" as EventType,
      stage: stageOf("jc.session"),
      status: "malformed",
      evidence_ref: `jc://session/${safe}`,
      integrity: { trust: "asserted" as const, basis: "jc_local_trace_unparseable", hash_verified: false, chain: "broken" as const, content_hash: "" },
      facts: { jc_session_id: safe, jc_session_ok: false, jc_parse_ok: false, jc_problem: str(reason, 60) } as Record<string, string | number | boolean | null>,
      flags: ["jc_trace_malformed"]
    });
  }

  private coverageEvent(workItemId: string, cov: Coverage): EvidenceEvent {
    return this.seal({
      ...this.base(workItemId),
      event_id: eventId("jc", `coverage.${workItemId}`),
      timestamp: null,
      event_type: "jc.coverage" as EventType,
      stage: stageOf("jc.coverage"),
      status: "incomplete",
      evidence_ref: "jc://coverage",
      integrity: { trust: "asserted" as const, basis: "jc_trace_scan_report", hash_verified: false, chain: "not_chained" as const, content_hash: "" },
      facts: {
        jc_roots_total: cov.rootsTotal,
        jc_roots_unreadable: cov.rootsUnreadable,
        jc_files_beyond_bound: cov.filesBeyondBound,
        jc_files_skipped: cov.filesSkipped,
        jc_files_unreadable: cov.filesUnreadable
      } as Record<string, string | number | boolean | null>,
      flags: ["jc_coverage_incomplete"]
    });
  }

  private toEvidence(runId: string, all: JcLocalTraceEvent[], matching: JcLocalTraceEvent[], workItemId: string): EvidenceEvent[] {
    const sessionId = ID_RE.test(runId) ? runId : "invalid-session-id";
    const chainOk = ID_RE.test(runId) && verifyJcLocalTrace(all);

    // Attribution accounting over the WHOLE session (what cross-work-item sessions and missing ids look like).
    let withoutWorkItem = 0;
    let invalidWorkItem = 0;
    let notInterpreted = 0;
    const open = new Map<string, number>();
    for (const e of all) {
      const key = `${String(e.payload.tool)}|${String(e.payload.argumentsSha256)}`;
      if (e.type === "tool_call_started") {
        open.set(key, (open.get(key) ?? 0) + 1);
      } else if (e.type === "tool_call_finished") {
        if ((open.get(key) ?? 0) > 0) open.set(key, (open.get(key) ?? 0) - 1);
        const w = workItemOf(e);
        if (!w.present) withoutWorkItem += 1;
        else if (w.id === null) invalidWorkItem += 1;
      } else {
        notInterpreted += 1; // valid JC event types this reader does not interpret (routing, approval, run lifecycle, ...)
      }
    }
    const unmatchedStarts = [...open.values()].reduce((a, b) => a + b, 0);
    const flags: string[] = [];
    if (!chainOk) flags.push("jc_chain_broken");
    if (withoutWorkItem + invalidWorkItem > 0) flags.push("jc_events_unattributed");
    if (unmatchedStarts > 0) flags.push("jc_unmatched_tool_starts");

    const session = this.seal({
      ...this.base(workItemId),
      event_id: eventId("jc", `${sessionId}.session`),
      timestamp: normalizeTimestamp(all[0]?.ts) ?? null,
      event_type: "jc.session" as EventType,
      stage: stageOf("jc.session"),
      status: chainOk ? "verified" : "broken",
      evidence_ref: `jc://session/${sessionId}`,
      integrity: {
        trust: "asserted" as const,
        basis: "jc_local_trace_chain",
        hash_verified: chainOk,
        chain: chainOk ? ("verified" as const) : ("broken" as const),
        content_hash: ""
      },
      facts: {
        jc_session_id: sessionId,
        jc_session_ok: chainOk,
        jc_parse_ok: true,
        jc_session_events: all.length,
        jc_events_for_work_item: matching.length,
        jc_events_without_work_item: withoutWorkItem,
        jc_events_invalid_work_item: invalidWorkItem,
        jc_events_not_interpreted: notInterpreted,
        jc_unmatched_starts: unmatchedStarts
      } as Record<string, string | number | boolean | null>,
      flags
    });
    // A broken chain is reported but its contents are NOT used: an edited or spliced trace is not evidence.
    if (!chainOk) return [session];

    const events: EvidenceEvent[] = [session];
    for (const e of matching) {
      if (e.type !== "tool_call_finished") continue; // only finished calls carry a work item id in real JC traces
      const p = e.payload;
      const okFlag = typeof p.ok === "boolean" ? p.ok : null;
      const rawCode = p.code;
      const codeOk = rawCode === undefined || rawCode === null || (typeof rawCode === "string" && CODE_RE.test(rawCode));
      const sha = typeof p.argumentsSha256 === "string" && SHA_RE.test(p.argumentsSha256) ? p.argumentsSha256 : null;
      const clean = sanitizeUntrusted(p);
      const evFlags: string[] = [];
      if (okFlag === null) evFlags.push("jc_outcome_malformed");
      if (!codeOk) evFlags.push("jc_code_malformed");
      if (clean.flags.includes("injection_suspected")) evFlags.push("injection_suspected");
      events.push(
        this.seal({
          ...this.base(workItemId),
          event_id: eventId("jc", `${sessionId}.${e.seq}`),
          timestamp: normalizeTimestamp(e.ts),
          event_type: "jc.tool.finished" as EventType,
          stage: stageOf("jc.tool.finished"),
          tool_name: str(p.tool),
          // JC's own account of ONE tool call. It says nothing about whether the ACS work item completed.
          status: okFlag === true ? "succeeded" : okFlag === false ? "failed" : "unknown",
          evidence_ref: `jc://session/${sessionId}#${e.seq}`,
          integrity: { trust: "asserted" as const, basis: "jc_local_trace_self_report", hash_verified: true, chain: "verified" as const, content_hash: "" },
          facts: {
            jc_session_id: sessionId,
            jc_seq: e.seq,
            jc_ok: okFlag,
            jc_code: codeOk && typeof rawCode === "string" ? rawCode : null,
            jc_arguments_sha256: sha
          } as Record<string, string | number | boolean | null>,
          untrusted: isRecord(clean.value) ? (clean.value as Record<string, unknown>) : {},
          flags: evFlags
        })
      );
    }
    return events;
  }
}
