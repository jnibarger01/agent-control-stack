/**
 * Who is connecting to the Jace Commander (`/jc/mcp`) and Desktop Commander (`/mcp`) edge lanes.
 *
 * The edge verifies the OAuth token and tells ACS the `client_id` and subject. Everything else about the
 * caller (`initialize.clientInfo`, User-Agent) is self-declared and kept only as an unverified claim.
 * This module keeps a bounded in-memory index built from the audit log, records connect observations and
 * operator labels as audit events, and (optionally, fail closed) denies unlabelled clients.
 *
 * It grants no authority: a label never approves, widens or issues anything. In `require_label` mode it can
 * only deny. Capability issuance, policy, approval and lease checks are unchanged.
 */
import { createHash } from "node:crypto";
import { redactValue } from "@agent-control-stack/shared";
import type { StoredAuditEvent, WorkItemStore } from "@agent-control-stack/work-items";

export type McpLane = "jc" | "dc";
export const MCP_LANES: readonly McpLane[] = ["jc", "dc"];
export const MCP_CLIENT_KINDS = ["chatgpt", "muse", "grok", "claude", "gemini", "other"] as const;
export type McpClientKind = (typeof MCP_CLIENT_KINDS)[number];
export type McpClientPolicy = "observe" | "require_label";

export const MCP_CLIENT_EVENTS = {
  seen: "mcp_client.seen",
  labelled: "mcp_client.labelled",
  labelCleared: "mcp_client.label_cleared"
} as const;

/** A client counts as live if it was seen this recently. */
export const MCP_CLIENT_LIVE_WINDOW_MS = 5 * 60_000;
export const MAX_TRACKED_CLIENTS = 500;
const SEEN_DEDUPE_MS = 30_000;
const MAX_CLAIMS = 5;
const MAX_SUBJECTS = 20;

export interface McpClientClaims {
  name?: string;
  version?: string;
  userAgent?: string;
}

export interface McpClientView {
  clientId: string;
  status: "labelled" | "unrecognized";
  label?: string;
  kind?: McpClientKind;
  note?: string;
  labelledAt?: string;
  labelledBy?: string;
  /** Guess from the unverified claims. Shown as a suggestion, never applied. */
  suggestedKind?: McpClientKind;
  lanes: McpLane[];
  subjects: string[];
  claims: McpClientClaims[];
  firstSeenAt: string;
  lastSeenAt: string;
  connects: number;
  issued: number;
  denied: number;
  lastTool?: string;
  lastMethod?: string;
  live: boolean;
}

export interface McpLegacyCaller {
  subject: string;
  lane: McpLane;
  issued: number;
  denied: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastTool?: string;
}

export interface McpClientSummary {
  total: number;
  labelled: number;
  unrecognized: number;
  liveUnrecognized: number;
  policy: McpClientPolicy;
}

interface ClientState {
  clientId: string;
  label?: { label: string; kind: McpClientKind; note?: string; at: string; by: string };
  lanes: Set<McpLane>;
  subjects: string[];
  claims: McpClientClaims[];
  firstSeenMs: number;
  lastSeenMs: number;
  connects: number;
  issued: number;
  denied: number;
  lastTool?: string;
  lastMethod?: string;
}

const PRINTABLE = /[^\x20-\x7e]/gu;

/** Bound and strip a self-declared string. Claims are display text only. */
export function sanitizeClaim(value: unknown, max = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(PRINTABLE, "").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

const CLIENT_ID_PATTERN = /^[\x21-\x7e]{1,256}$/u;
export function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

/**
 * The one identity used for a client everywhere (index, labels, audit, gate). The audit log redacts
 * secret-shaped values, so a client id such as `https://c.example/sk-.../metadata.json` would be stored as
 * `[redacted]` while the gate still saw the original. Those ids are replaced by a stable digest instead.
 */
export function canonicalClientId(raw: unknown): string | undefined {
  if (!isValidClientId(raw)) return undefined;
  if (redactValue(raw) === raw) return raw;
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function normalizeClaims(input: McpClientClaims | undefined): McpClientClaims {
  const name = sanitizeClaim(input?.name);
  const version = sanitizeClaim(input?.version, 64);
  const userAgent = sanitizeClaim(input?.userAgent, 200);
  return { ...(name ? { name } : {}), ...(version ? { version } : {}), ...(userAgent ? { userAgent } : {}) };
}

/** Best-effort guess from what the client says about itself. Never used for any decision. */
export function suggestKind(claims: readonly McpClientClaims[]): McpClientKind | undefined {
  const text = claims.map((c) => `${c.name ?? ""} ${c.userAgent ?? ""}`).join(" ");
  if (/openai|chatgpt|gpt/iu.test(text)) return "chatgpt";
  if (/\bmuse\b/iu.test(text)) return "muse";
  if (/grok|\bx\.?ai\b|xai/iu.test(text)) return "grok";
  if (/claude|anthropic/iu.test(text)) return "claude";
  if (/gemini|google/iu.test(text)) return "gemini";
  return undefined;
}

export function parseMcpClientPolicy(env: NodeJS.ProcessEnv = process.env): McpClientPolicy {
  const raw = env.ACS_MCP_CLIENT_POLICY?.trim();
  if (!raw || raw === "observe") return "observe";
  if (raw === "require_label") return "require_label";
  throw new Error("ACS_MCP_CLIENT_POLICY must be observe or require_label");
}

function eventMs(event: StoredAuditEvent): number {
  const ms = Math.floor(Number(event.timeUnixNano) / 1e6);
  return Number.isFinite(ms) ? ms : 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface McpClientObservation {
  lane: McpLane;
  clientId: string;
  subject: string;
  method: string;
  claims?: McpClientClaims;
}

export class McpClientService {
  private readonly clients = new Map<string, ClientState>();
  private readonly legacy = new Map<string, McpLegacyCaller & { firstMs: number; lastMs: number }>();
  private readonly lastSeenWrite = new Map<string, number>();

  constructor(
    private readonly store: Pick<WorkItemStore, "recordSystemEvent" | "readEvents">,
    readonly policy: McpClientPolicy = "observe",
    private readonly now: () => number = Date.now
  ) {}

  /** Rebuild the index from the retained audit log. Called once at startup. */
  hydrate(pageSize = 1_000, maxPages = 20): void {
    // Collect every relevant event, then replay them in one global sequence order. Replaying each type as its
    // own batch would apply all labels before all clears and resurrect a cleared (or clear a re-applied) label.
    const all: StoredAuditEvent[] = [];
    for (const name of [
      MCP_CLIENT_EVENTS.labelled,
      MCP_CLIENT_EVENTS.labelCleared,
      MCP_CLIENT_EVENTS.seen,
      "connector.requested"
    ]) {
      let before: number | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const events = this.store.readEvents({
          name,
          limit: pageSize,
          ...(before !== undefined ? { beforeSequence: before } : {})
        });
        if (events.length === 0) break;
        all.push(...events);
        before = events[0]!.sequence;
        if (events.length < pageSize) break;
      }
    }
    all.sort((x, y) => x.sequence - y.sequence);
    for (const event of all) this.ingestEvent(event, true);
    this.enforceCap();
  }

  /** Apply one audit event to the index. Wired to the gateway's live event stream. */
  ingest(event: StoredAuditEvent): void {
    this.ingestEvent(event, false);
  }

  private state(clientId: string, ms: number): ClientState {
    let state = this.clients.get(clientId);
    if (!state) {
      state = {
        clientId,
        lanes: new Set(),
        subjects: [],
        claims: [],
        firstSeenMs: ms,
        lastSeenMs: ms,
        connects: 0,
        issued: 0,
        denied: 0
      };
      this.clients.set(clientId, state);
    }
    return state;
  }

  private touch(
    state: ClientState,
    ms: number,
    lane: McpLane | undefined,
    subject: string | undefined,
    claims: McpClientClaims
  ): void {
    state.firstSeenMs = Math.min(state.firstSeenMs, ms);
    state.lastSeenMs = Math.max(state.lastSeenMs, ms);
    if (lane) state.lanes.add(lane);
    if (subject && !state.subjects.includes(subject) && state.subjects.length < MAX_SUBJECTS)
      state.subjects.push(subject);
    if (Object.keys(claims).length > 0) {
      const key = JSON.stringify(claims);
      state.claims = [claims, ...state.claims.filter((c) => JSON.stringify(c) !== key)].slice(0, MAX_CLAIMS);
    }
  }

  private ingestEvent(event: StoredAuditEvent, bulk: boolean): void {
    const body = event.body as Record<string, unknown>;
    const ms = eventMs(event);
    // `mcp_client.seen` carries clientName/clientVersion/userAgent; `connector.requested` prefixes them with mcp.
    const claims = normalizeClaims({
      name: (body.mcpClientName ?? body.clientName) as string | undefined,
      version: (body.mcpClientVersion ?? body.clientVersion) as string | undefined,
      userAgent: (body.mcpUserAgent ?? body.userAgent) as string | undefined
    });
    if (event.name === "connector.requested") {
      const source = String(body.source ?? "");
      const match = /^(jc|dc)-capability-(issued|denied)$/u.exec(source);
      if (!match) return;
      const lane = match[1] as McpLane;
      const outcome = match[2] as "issued" | "denied";
      const subject = sanitizeClaim(body.authSubject, 128);
      const tool = sanitizeClaim(body.toolName, 128);
      const clientId = body.mcpClientId;
      if (isValidClientId(clientId)) {
        const state = this.state(clientId, ms);
        this.touch(state, ms, lane, subject, claims);
        if (outcome === "issued") state.issued += 1;
        else state.denied += 1;
        if (tool && ms >= (state.lastSeenMs ?? 0)) state.lastTool = tool;
        state.lastMethod = "tools/call";
      } else if (subject) {
        const key = `${lane}|${subject}`;
        const row = this.legacy.get(key) ?? {
          subject,
          lane,
          issued: 0,
          denied: 0,
          firstSeenAt: iso(ms),
          lastSeenAt: iso(ms),
          firstMs: ms,
          lastMs: ms
        };
        row.firstMs = Math.min(row.firstMs, ms);
        row.lastMs = Math.max(row.lastMs, ms);
        row.firstSeenAt = iso(row.firstMs);
        row.lastSeenAt = iso(row.lastMs);
        if (outcome === "issued") row.issued += 1;
        else row.denied += 1;
        if (tool) row.lastTool = tool;
        this.legacy.set(key, row);
      }
    } else if (event.name === MCP_CLIENT_EVENTS.seen) {
      const clientId = body.clientId;
      if (!isValidClientId(clientId)) return;
      const lane = body.lane === "dc" ? "dc" : "jc";
      const state = this.state(clientId, ms);
      this.touch(state, ms, lane, sanitizeClaim(body.subject, 128), claims);
      state.connects += 1;
      const method = sanitizeClaim(body.method, 64);
      if (method) state.lastMethod = method;
    } else if (event.name === MCP_CLIENT_EVENTS.labelled) {
      const clientId = body.clientId;
      const kind = MCP_CLIENT_KINDS.find((k) => k === body.kind);
      const label = sanitizeClaim(body.label, 64);
      if (!isValidClientId(clientId) || !kind || !label) return;
      const state = this.state(clientId, ms);
      state.label = {
        label,
        kind,
        at: iso(ms),
        by: sanitizeClaim(body.actorId, 128) ?? "unknown",
        ...(sanitizeClaim(body.note, 200) ? { note: sanitizeClaim(body.note, 200)! } : {})
      };
    } else if (event.name === MCP_CLIENT_EVENTS.labelCleared) {
      const clientId = body.clientId;
      if (!isValidClientId(clientId)) return;
      const state = this.clients.get(clientId);
      if (state) delete state.label;
    }
    if (!bulk) this.enforceCap();
  }

  /** Bound memory: drop the least recently seen unlabelled clients first. Labelled clients are kept. */
  private enforceCap(): void {
    if (this.clients.size <= MAX_TRACKED_CLIENTS) return;
    const evictable = [...this.clients.values()].filter((c) => !c.label).sort((a, b) => a.lastSeenMs - b.lastSeenMs);
    for (const state of evictable) {
      if (this.clients.size <= MAX_TRACKED_CLIENTS) break;
      this.clients.delete(state.clientId);
    }
  }

  list(): McpClientView[] {
    const now = this.now();
    return [...this.clients.values()]
      .map((state): McpClientView => {
        const suggested = suggestKind(state.claims);
        return {
          clientId: state.clientId,
          status: state.label ? "labelled" : "unrecognized",
          ...(state.label
            ? {
                label: state.label.label,
                kind: state.label.kind,
                labelledAt: state.label.at,
                labelledBy: state.label.by,
                ...(state.label.note ? { note: state.label.note } : {})
              }
            : {}),
          ...(suggested ? { suggestedKind: suggested } : {}),
          lanes: [...state.lanes].sort(),
          subjects: state.subjects,
          claims: state.claims,
          firstSeenAt: iso(state.firstSeenMs),
          lastSeenAt: iso(state.lastSeenMs),
          connects: state.connects,
          issued: state.issued,
          denied: state.denied,
          ...(state.lastTool ? { lastTool: state.lastTool } : {}),
          ...(state.lastMethod ? { lastMethod: state.lastMethod } : {}),
          live: now - state.lastSeenMs <= MCP_CLIENT_LIVE_WINDOW_MS
        };
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  legacyCallers(): McpLegacyCaller[] {
    return [...this.legacy.values()]
      .map(({ firstMs: _a, lastMs: _b, ...row }) => row)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  summary(): McpClientSummary {
    const clients = this.list();
    const unrecognized = clients.filter((c) => c.status === "unrecognized");
    return {
      total: clients.length,
      labelled: clients.length - unrecognized.length,
      unrecognized: unrecognized.length,
      liveUnrecognized: unrecognized.filter((c) => c.live).length,
      policy: this.policy
    };
  }

  isLabelled(clientId: string): boolean {
    return Boolean(this.clients.get(clientId)?.label);
  }

  /**
   * Decide whether a caller may proceed to normal issuance. In `observe` mode always yes. In
   * `require_label` mode only a labelled client may; this can only deny, never grant.
   */
  gate(clientId: string): { ok: true } | { ok: false; code: "mcp_client_unlabelled"; detail: string } {
    if (this.policy === "observe" || this.isLabelled(clientId)) return { ok: true };
    return {
      ok: false,
      code: "mcp_client_unlabelled",
      detail: "This MCP client is not labelled in Mission Control. An operator must label it before it can use ACS."
    };
  }

  /** Record that a client connected (initialize/tools/list). Throttled so a chatty client cannot flood the log. */
  observe(input: McpClientObservation): { recorded: boolean } {
    const clientId = canonicalClientId(input.clientId);
    if (!clientId) return { recorded: false };
    const subject = sanitizeClaim(input.subject, 128);
    const method = sanitizeClaim(input.method, 64) ?? "unknown";
    const key = `${input.lane}|${clientId}|${subject ?? ""}|${method}`;
    const now = this.now();
    const last = this.lastSeenWrite.get(key);
    if (last !== undefined && now - last < SEEN_DEDUPE_MS) return { recorded: false };
    this.lastSeenWrite.set(key, now);
    if (this.lastSeenWrite.size > 5_000) {
      for (const [k, t] of this.lastSeenWrite) if (now - t > SEEN_DEDUPE_MS) this.lastSeenWrite.delete(k);
    }
    const claims = normalizeClaims(input.claims);
    this.store.recordSystemEvent({
      name: MCP_CLIENT_EVENTS.seen,
      body: {
        lane: input.lane,
        clientId,
        ...(subject ? { subject } : {}),
        method,
        ...(claims.name ? { clientName: claims.name } : {}),
        ...(claims.version ? { clientVersion: claims.version } : {}),
        ...(claims.userAgent ? { userAgent: claims.userAgent } : {})
      },
      attributes: { "mcp.client_id": clientId, "mcp.lane": input.lane }
    });
    return { recorded: true };
  }

  label(input: {
    clientId: string;
    kind: McpClientKind;
    label: string;
    note?: string;
    actorId: string;
  }): McpClientView {
    if (!isValidClientId(input.clientId)) throw new McpClientError("mcp_client_invalid", "client id is not valid");
    const label = sanitizeClaim(input.label, 64);
    if (!label) throw new McpClientError("mcp_client_invalid", "a label is required");
    if (!MCP_CLIENT_KINDS.includes(input.kind)) throw new McpClientError("mcp_client_invalid", "unknown client kind");
    if (!this.clients.has(input.clientId)) {
      // Only clients ACS has actually seen can be labelled: a label cannot pre-authorize an invented id.
      throw new McpClientError("mcp_client_not_found", "this client has not connected to ACS");
    }
    const note = sanitizeClaim(input.note, 200);
    this.store.recordSystemEvent({
      name: MCP_CLIENT_EVENTS.labelled,
      body: { clientId: input.clientId, kind: input.kind, label, ...(note ? { note } : {}), actorId: input.actorId },
      attributes: { "mcp.client_id": input.clientId }
    });
    return this.list().find((c) => c.clientId === input.clientId)!;
  }

  clearLabel(clientId: string, actorId: string): McpClientView {
    if (!this.isLabelled(clientId)) throw new McpClientError("mcp_client_not_found", "this client has no label");
    this.store.recordSystemEvent({
      name: MCP_CLIENT_EVENTS.labelCleared,
      body: { clientId, actorId },
      attributes: { "mcp.client_id": clientId }
    });
    return this.list().find((c) => c.clientId === clientId)!;
  }
}

export class McpClientError extends Error {
  constructor(
    readonly code: "mcp_client_invalid" | "mcp_client_not_found",
    message: string
  ) {
    super(message);
  }
}
