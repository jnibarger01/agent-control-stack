/**
 * Read-mostly clients for the rest of the Jace stack.
 *
 * Authority boundaries (ACS ADR 0009 / 0011 / 0017):
 *  - ACS owns work items, policy, approvals, leases and the canonical audit.
 *    The only write here is `submitMission`, which asks ACS to create a
 *    governed work item; ACS decides allow / deny / require_approval.
 *  - codex-swarm is a subordinate execution engine: read-only here.
 *  - The visualizer is a loopback, same-UID observability surface: read-only.
 *  - Mission Router is retired (no live runtime); only its local state under
 *    ~/.mission-router is listed and chain-verified, never mutated.
 * Every view is an explicit allowlist entry; callers cannot supply paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JcConfig } from './config.js';
import { readTraceFile, verifyChain, type ChainVerification } from './looptrace.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class IntegrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface HttpResult {
  status: number;
  body: unknown;
}

/** Reads the body incrementally and aborts as soon as `limit` bytes are exceeded. */
async function readBounded(response: Response, limit: number, controller: AbortController): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw new IntegrationError('response_too_large', 'upstream response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestJson(
  url: string,
  init: { method?: 'GET' | 'POST'; token?: string; body?: unknown; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await (init.fetchImpl ?? fetch)(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      redirect: 'error', // never follow a redirect off the configured origin
    });
    const text = await readBounded(response, MAX_RESPONSE_BYTES, controller);
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // non-JSON bodies are returned as text
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    // Do not echo the URL or token: report reachability only.
    throw new IntegrationError('upstream_unreachable', (error as Error).name === 'AbortError' ? 'upstream timed out' : 'upstream unreachable');
  } finally {
    clearTimeout(timer);
  }
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new IntegrationError('invalid_argument', `${name} must match ${ID_PATTERN}`);
  return value;
}

// --- ACS ---------------------------------------------------------------------

export const ACS_VIEWS = ['health', 'work-items', 'work-item'] as const;
export type AcsView = typeof ACS_VIEWS[number];
// Mirrors ACS packages/work-items workItemStatusSchema.
const WORK_ITEM_STATUSES = new Set([
  'draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'cancelling',
  'succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'unknown', 'quarantined',
]);

export function acsReadUrl(config: JcConfig, view: AcsView, id?: string, status?: string): string {
  switch (view) {
    case 'health':
      return `${config.acsUrl}/health`;
    case 'work-items': {
      if (status !== undefined && !WORK_ITEM_STATUSES.has(status)) throw new IntegrationError('invalid_argument', 'unknown work-item status');
      return `${config.acsUrl}/work-items${status ? `?status=${encodeURIComponent(status)}` : ''}`;
    }
    case 'work-item':
      return `${config.acsUrl}/work-items/${encodeURIComponent(requireId(id, 'id'))}`;
    default:
      throw new IntegrationError('invalid_argument', 'unknown ACS view');
  }
}

export interface MissionInput {
  title: string;
  intent: string;
  target: Record<string, unknown>;
  requestedActions?: unknown[];
  risk?: 'low' | 'medium' | 'high' | 'critical';
  correlationId?: string;
}

/** Body sent to ACS POST /work-items. requester/status are ACS-derived and never sent. */
export function missionWorkItemBody(input: MissionInput): Record<string, unknown> {
  if (typeof input.title !== 'string' || input.title.length === 0 || input.title.length > 200) throw new IntegrationError('invalid_argument', 'title must be 1..200 chars');
  if (typeof input.intent !== 'string' || input.intent.length === 0 || input.intent.length > 8000) throw new IntegrationError('invalid_argument', 'intent must be 1..8000 chars');
  if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target)) throw new IntegrationError('invalid_argument', 'target must be an object');
  return {
    title: input.title,
    intent: input.intent,
    target: input.target,
    ...(input.requestedActions ? { requestedActions: input.requestedActions } : {}),
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.correlationId ? { metadata: { correlationId: requireId(input.correlationId, 'correlationId') } } : {}),
  };
}

// --- codex-swarm -------------------------------------------------------------

export const SWARM_VIEWS = ['health', 'mission-control', 'runs', 'status', 'task'] as const;
export type SwarmView = typeof SWARM_VIEWS[number];

export function swarmReadUrl(config: JcConfig, view: SwarmView, taskId?: string): string {
  const base = `${config.swarmUrl}/api/v1`;
  switch (view) {
    case 'health': return `${base}/health`;
    case 'mission-control': return `${base}/mission-control`;
    case 'runs': return `${base}/readonly/runs`;
    case 'status': return `${base}/readonly/status?task_id=${encodeURIComponent(requireId(taskId, 'taskId'))}`;
    case 'task': return `${base}/tasks/${encodeURIComponent(requireId(taskId, 'taskId'))}`;
    default: throw new IntegrationError('invalid_argument', 'unknown swarm view');
  }
}

// --- visualizer --------------------------------------------------------------

export const VISUALIZER_VIEWS = ['system-status', 'runtimes', 'executions', 'approvals', 'alerts', 'agents'] as const;
export type VisualizerView = typeof VISUALIZER_VIEWS[number];

export function visualizerReadUrl(config: JcConfig, view: VisualizerView): string {
  if (!config.visualizerUrl) throw new IntegrationError('not_configured', 'JC_VISUALIZER_URL is not set (the visualizer binds an ephemeral port unless pinned)');
  const url = new URL(config.visualizerUrl);
  // The visualizer rejects anything but Host=127.0.0.1[:port] and same-UID peers.
  if (url.hostname !== '127.0.0.1') throw new IntegrationError('not_configured', 'JC_VISUALIZER_URL must be http://127.0.0.1:<port>');
  if (!(VISUALIZER_VIEWS as readonly string[]).includes(view)) throw new IntegrationError('invalid_argument', 'unknown visualizer view');
  return `${config.visualizerUrl}/api/v1/${view}`;
}

// --- Mission Router (retired) + LoopTrace files -------------------------------

export interface MissionSummary {
  file: string;
  id: string | null;
  state: string | null;
}

export interface MissionRouterListing {
  directory: string;
  present: boolean;
  missions: MissionSummary[];
  chains: Array<{ file: string; events: number; verification: ChainVerification | { ok: false; reason: string } }>;
}

/**
 * Metadata only: mission goals/bodies are deliberately not returned (same
 * rule the ACS Mission Router inventory applied).
 */
export function listMissionRouterState(directory: string, maxFiles = 200): MissionRouterListing {
  if (!fs.existsSync(directory)) return { directory, present: false, missions: [], chains: [] };
  const missions: MissionSummary[] = [];
  const chains: MissionRouterListing['chains'] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (missions.length + chains.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const parsed = readTraceFile(full);
          chains.push({
            file: path.relative(directory, full),
            events: parsed.events.length,
            verification: parsed.parseError
              ? { ok: false, reason: `invalid JSON at line ${parsed.parseError.line}` }
              : verifyChain(parsed.events),
          });
        } catch (error) {
          chains.push({ file: path.relative(directory, full), events: 0, verification: { ok: false, reason: (error as Error).message } });
        }
      } else if (entry.name.endsWith('.json')) {
        let id: string | null = null;
        let state: string | null = null;
        try {
          const record = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
          const pick = (...keys: string[]) => {
            for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
            return null;
          };
          id = pick('id', 'mission_id', 'task_id');
          state = pick('state', 'status');
        } catch {
          // unreadable mission file: listed with null fields
        }
        missions.push({ file: path.relative(directory, full), id, state });
      }
    }
  };
  walk(directory, 0);
  return { directory, present: true, missions, chains };
}

function realpathOrResolve(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function resolveTracePath(requested: unknown, roots: readonly string[]): string {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new IntegrationError('invalid_argument', 'path must be absolute');
  const real = realpathOrResolve(requested);
  const inside = roots.some((root) => {
    const realRoot = realpathOrResolve(root);
    return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  });
  if (!inside) throw new IntegrationError('path_not_allowed', 'path is outside the configured LoopTrace roots');
  return real;
}
