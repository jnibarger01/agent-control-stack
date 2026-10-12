import { z } from "zod";
import { authenticate, canSee, requireScope, type Principal, type Scope } from "./authz.js";
import { correlate, type Correlated } from "./correlate.js";
import { View, buildGapReport, type GapReport } from "./gaps.js";
import { CONTRACT_VERSION, EVIDENCE_SCHEMA_VERSION, sha256Hex, type EvidenceEvent } from "./model.js";
import { AcsReadStore } from "./sources/acs-store.js";
import type { FetchLike } from "./sources/observers.js";
import { Deadline, LIMITS, QueryError, type Lookup, type QueryConfig, type SourceReport } from "./types.js";
import { overall, parseAssertions, verifyAssertions, type AssertionResult, type Verdict } from "./verify.js";

export const INVARIANT = "No evidence, no verified success. Asserted completion is never independent verification." as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/u, "identifier has invalid characters or length");

const lookupShape = {
  trace_id: id.optional(),
  request_id: id.optional(),
  work_item_id: id.optional(),
  execution_id: id.optional()
};
const hasId = (v: Record<string, unknown>): boolean => Boolean(v.trace_id || v.request_id || v.work_item_id || v.execution_id);
const ID_MSG = "at least one of trace_id, request_id, work_item_id, execution_id is required";

export const traceInputSchema = z
  .object({ ...lookupShape, page_size: z.number().int().min(1).max(LIMITS.maxPageSize).optional(), cursor: z.string().max(200).optional() })
  .strict()
  .refine(hasId, ID_MSG);
export const gapsInputSchema = z.object({ ...lookupShape }).strict().refine(hasId, ID_MSG);
export const verifyInputSchema = z
  .object({ ...lookupShape, assertions: z.array(z.unknown()).max(12) })
  .strict()
  .refine(hasId, ID_MSG);

interface Loaded {
  principal: Principal;
  lookup: Lookup;
  matchedBy: string[];
  views: Array<{ view: View; correlated: Correlated; notes: string[] }>;
  reports: SourceReport[];
}

export interface ServiceDeps {
  fetchImpl?: FetchLike;
}

export class LoopTraceQueryService {
  constructor(
    private readonly config: QueryConfig,
    private readonly deps: ServiceDeps = {}
  ) {}

  private guard(token: string | undefined | null, scope: Scope): Principal {
    const principal = authenticate(token, this.config.grantKey, this.config.now());
    requireScope(principal, scope);
    return principal;
  }

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const r = schema.safeParse(input);
    if (!r.success) {
      throw new QueryError("INVALID_ARGUMENT", (r.error.issues[0]?.message ?? "invalid input").slice(0, 240));
    }
    return r.data;
  }

  private load(lookup: Lookup, principal: Principal): Loaded {
    const deadline = new Deadline(LIMITS.queryDeadlineMs, () => this.config.now().getTime());
    const reports: SourceReport[] = [];
    if (!this.config.acsDbPath) {
      throw new QueryError("SOURCE_NOT_CONFIGURED", "the ACS evidence source is not configured");
    }
    let store: AcsReadStore;
    try {
      store = new AcsReadStore(this.config.acsDbPath, this.config.now);
    } catch {
      throw new QueryError("SOURCE_UNAVAILABLE", "the ACS evidence source could not be opened read-only");
    }
    try {
      const resolved = store.resolve(lookup);
      // Resource-level authorization BEFORE anything is revealed: out-of-scope == not found.
      const visible = resolved.ids.filter((wid) => {
        const ref = store.workItemRef(wid);
        return ref !== null && canSee(principal, ref);
      });
      if (visible.length === 0) throw new QueryError("NOT_FOUND", "no evidence found for the supplied identifier(s)");
      if (visible.length > LIMITS.maxWorkItemsPerQuery) {
        throw new QueryError("INVALID_ARGUMENT", `identifier matches more than ${LIMITS.maxWorkItemsPerQuery} work items; narrow the query`);
      }
      if (visible.length > 1 && !lookup.trace_id && !lookup.work_item_id) {
        throw new QueryError("AMBIGUOUS_IDENTIFIER", "the identifier matches multiple work items; supply work_item_id or trace_id");
      }
      const views: Loaded["views"] = [];
      const acsNotes: string[] = [];
      let acsEvents = 0;
      for (const wid of visible) {
        if (deadline.expired()) throw new QueryError("DEADLINE_EXCEEDED", "query deadline exceeded");
        const collected = store.collect(wid);
        acsNotes.push(...collected.notes);
        acsEvents += collected.events.length;
        views.push({ view: new View(wid, collected.events), correlated: correlate(collected.events), notes: collected.notes });
      }
      reports.push({ source: "acs", status: "ok", events: acsEvents, detail: acsNotes.join("; ").slice(0, 400) || undefined });
      reports.push(
        { source: "jace_commander_chain", status: this.config.jcTraceRoots.length ? "unavailable" : "not_configured", events: 0, detail: "JC local trace correlation is not enabled in this build; JC outcomes are visible only as ACS-recorded capability/tool events" },
        { source: "hermes", status: this.config.hermesStateDb ? "unavailable" : "not_configured", events: 0, detail: "Hermes session metadata correlation is not enabled in this build" }
      );
      return { principal, lookup, matchedBy: resolved.matchedBy, views, reports };
    } finally {
      store.close();
    }
  }

  // ------------------------------------------------------------------ trace

  async trace(input: unknown, token: string | undefined | null): Promise<Record<string, unknown>> {
    const principal = this.guard(token, "looptrace:trace");
    const args = this.parse(traceInputSchema, input);
    const loaded = this.load(pickLookup(args), principal);

    const all: EvidenceEvent[] = loaded.views.flatMap((v) => v.correlated.events);
    const ordered = correlate(all).events;
    const size = args.page_size ?? LIMITS.defaultPageSize;
    const querySig = sha256Hex(JSON.stringify([loaded.views.map((v) => v.view.workItemId), ordered.length])).slice(0, 16);
    let offset = 0;
    if (args.cursor) {
      try {
        const c = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")) as { o?: unknown; q?: unknown };
        if (typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0 || c.q !== querySig) throw new Error("stale");
        offset = c.o;
      } catch {
        throw new QueryError("INVALID_ARGUMENT", "cursor is invalid or no longer matches the evidence set; restart without a cursor");
      }
    }
    const page = ordered.slice(offset, offset + size);
    const next = offset + size < ordered.length ? Buffer.from(JSON.stringify({ o: offset + size, q: querySig }), "utf8").toString("base64url") : null;
    const count = (t: string): number => ordered.filter((e) => e.integrity.trust === t).length;
    return {
      contract_version: CONTRACT_VERSION,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      generated_at: this.config.now().toISOString(),
      invariant: INVARIANT,
      matched_by: loaded.matchedBy,
      work_items: loaded.views.map((v) => ({
        work_item_id: v.view.workItemId,
        trace_id: v.view.events[0]?.trace_id ?? null,
        request_id: v.view.events[0]?.request_id ?? null,
        status: v.view.status
      })),
      trust_summary: { authoritative: count("authoritative"), observed: count("observed"), asserted: count("asserted") },
      events: page,
      page: { size, offset, total: ordered.length, next_cursor: next },
      anomalies: summarizeAnomalies(loaded.views.map((v) => v.correlated)),
      sources: loaded.reports,
      notes: loaded.views.flatMap((v) => v.notes).slice(0, 20)
    };
  }

  // ------------------------------------------------------------------- gaps

  async gaps(input: unknown, token: string | undefined | null): Promise<Record<string, unknown>> {
    const principal = this.guard(token, "looptrace:gaps");
    const args = this.parse(gapsInputSchema, input);
    const loaded = this.load(pickLookup(args), principal);
    const now = this.config.now();
    const reports: Array<{ work_item_id: string } & GapReport> = loaded.views.map((v) => ({
      work_item_id: v.view.workItemId,
      ...buildGapReport(v.view, v.correlated, loaded.reports.filter((r) => r.source === "acs"), now)
    }));
    return {
      contract_version: CONTRACT_VERSION,
      generated_at: now.toISOString(),
      invariant: INVARIANT,
      matched_by: loaded.matchedBy,
      reports,
      sources: loaded.reports
    };
  }

  // ----------------------------------------------------------------- verify

  async verify(input: unknown, token: string | undefined | null): Promise<Record<string, unknown>> {
    const principal = this.guard(token, "looptrace:verify");
    const args = this.parse(verifyInputSchema, input);
    const assertions = parseAssertions(args.assertions);
    const lookup = pickLookup(args);
    const now = this.config.now();

    let loaded: Loaded;
    try {
      loaded = this.load(lookup, principal);
    } catch (error) {
      if (error instanceof QueryError && error.code === "SOURCE_UNAVAILABLE") {
        return {
          contract_version: CONTRACT_VERSION,
          generated_at: now.toISOString(),
          invariant: INVARIANT,
          verdict: "ERROR" satisfies Verdict,
          error: { code: error.code, message: error.message },
          assertions: [],
          sources: [{ source: "acs", status: "unavailable", events: 0 }]
        };
      }
      throw error;
    }
    if (loaded.views.length !== 1) {
      throw new QueryError("AMBIGUOUS_IDENTIFIER", "verification requires exactly one work item; supply work_item_id");
    }
    const { view, correlated } = loaded.views[0]!;
    const results: AssertionResult[] = await verifyAssertions(assertions, view, correlated, loaded.reports, {
      releaseRoots: this.config.releaseRoots,
      healthTargets: this.config.healthTargets,
      fetchImpl: this.deps.fetchImpl,
      now
    });
    // Every verdict names the evidence it rests on; when nothing supports it, the examined subject is named.
    const subject = view.of("request.received")[0]?.evidence_ref;
    for (const r of results) if (r.evidence_refs.length === 0 && subject) r.evidence_refs = [subject];
    const gaps = buildGapReport(view, correlated, loaded.reports.filter((r) => r.source === "acs"), now);
    return {
      contract_version: CONTRACT_VERSION,
      generated_at: now.toISOString(),
      invariant: INVARIANT,
      work_item_id: view.workItemId,
      verdict: overall(results),
      assertions: results,
      evidence_refs: [...new Set(results.flatMap((r) => r.evidence_refs))].sort(),
      completeness: gaps.completeness,
      blocking_gaps: gaps.gaps.filter((g) => g.severity === "critical" || g.severity === "high").map((g) => ({ code: g.code, severity: g.severity })),
      caveats: [
        "Verification reads evidence; it does not authorize, approve, retry or change anything.",
        "PASS requires authoritative or independently observed evidence. Worker/agent self-reports can only yield INCONCLUSIVE."
      ],
      sources: loaded.reports
    };
  }
}

function pickLookup(a: Lookup): Lookup {
  return { trace_id: a.trace_id, request_id: a.request_id, work_item_id: a.work_item_id, execution_id: a.execution_id };
}

function summarizeAnomalies(cs: Correlated[]): Record<string, number> {
  return {
    duplicates: cs.reduce((n, c) => n + c.duplicates.length, 0),
    conflicts: cs.reduce((n, c) => n + c.conflicts.length, 0),
    clock_skew: cs.reduce((n, c) => n + c.skew.length, 0),
    lost_parents: cs.reduce((n, c) => n + c.missingCauses.length, 0),
    untimed: cs.reduce((n, c) => n + c.untimed.length, 0)
  };
}
