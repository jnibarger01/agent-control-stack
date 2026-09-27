import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { authorizationArguments, strictCanonicalJsonV1 } from '../managed-acs.js';

/**
 * Per-call request context: a DC-generated requestId, the caller-supplied
 * correlation id (if any), the normalized-arguments hash and origin. Carried
 * through async execution so errors, last_error records and execution events
 * are correlated without threading parameters through every handler.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string | null;
  tool: string;
  normalizedArgumentsHash: string | null;
  origin: 'ui' | 'llm' | null;
  startedAt: number;
  /** ACS attribution relayed from a VERIFIED capability (never self-asserted). */
  acs?: { workItemId: string; attemptId: string; leaseId: string };
  /**
   * Set by the enforcement gate when DC_NETWORK_PROFILE=none: the scrubbed
   * spawn environment and whether `unshare -n` isolation is usable. Tools
   * that spawn processes MUST honour it.
   */
  networkIsolation?: { profile: 'none'; env: Record<string, string>; sandboxAvailable: boolean };
  /** Tool-specific evidence merged into the execution event. */
  evidence: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Hash of the authorizationArguments (acs.dc.v1 contract: transport metadata
 * removed, strict canonical JSON). Matches what ACS binds, so events and
 * ACS records can be joined on it. Null when the arguments are not
 * canonicalizable (e.g. invalid transport metadata).
 */
export function normalizedArgumentsHash(args: unknown): string | null {
  try {
    return sha256Hex(strictCanonicalJsonV1(authorizationArguments(args ?? {})));
  } catch {
    return null;
  }
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export function correlationIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  for (const candidate of [m.correlationId, m.requestId, (m['io.modelcontextprotocol/related-task'] as any)?.taskId]) {
    if (typeof candidate === 'string' && CORRELATION_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

export function newRequestId(): string {
  return `dcreq_${crypto.randomUUID()}`;
}

export function createRequestContext(tool: string, args: unknown, meta: unknown): RequestContext {
  const origin = args && typeof args === 'object' && ((args as any).origin === 'ui' || (args as any).origin === 'llm')
    ? (args as any).origin as 'ui' | 'llm'
    : null;
  return {
    requestId: newRequestId(),
    correlationId: correlationIdFromMeta(meta),
    tool,
    normalizedArgumentsHash: normalizedArgumentsHash(args),
    origin,
    startedAt: Date.now(),
    evidence: {},
  };
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Attach tool-specific evidence (hashes, exit code, cwd, …) to the current call. */
export function recordEvidence(evidence: Record<string, unknown>): void {
  const context = storage.getStore();
  if (context) Object.assign(context.evidence, evidence);
}
