import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { strictCanonicalJsonV1 } from '../managed-acs.js';
import { sha256Hex } from './context.js';
import { executionEvents } from './events.js';

/**
 * health: read-only, degraded-mode-safe status report.
 *
 * Every subsystem probe is isolated (try/catch) and time-bounded, so one
 * broken subsystem yields a degraded/unhealthy entry instead of crashing the
 * tool. No secrets: only statuses, counts, codes and hashes.
 */
export type SubsystemStatus = 'ok' | 'degraded' | 'unhealthy';

export interface SubsystemReport {
  status: SubsystemStatus;
  reason: string;
  errorCode?: string;
  [key: string]: unknown;
}

export type HealthProbe = () => Promise<SubsystemReport>;

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  build: { commit: string | null; source: string };
  pid: number;
  uptimeSeconds: number;
  checkedAt: string;
  configHash: string | null;
  allowlistHash: string | null;
  subsystems: Record<string, SubsystemReport>;
}

const PROBE_TIMEOUT_MS = 2_000;

async function runProbe(probe: HealthProbe): Promise<SubsystemReport> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<SubsystemReport>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unhealthy', reason: 'probe timed out', errorCode: 'DC_TIMEOUT' }), PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const code = typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code : 'DC_SUBSYSTEM_UNAVAILABLE';
    return { status: 'unhealthy', reason: 'probe failed', errorCode: code };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build identity from the checkout that produced dist/ (fs only, no spawn). */
export function buildCommit(): { commit: string | null; source: string } {
  if (process.env.DC_BUILD_COMMIT && /^[a-f0-9]{7,64}$/.test(process.env.DC_BUILD_COMMIT)) {
    return { commit: process.env.DC_BUILD_COMMIT, source: 'env:DC_BUILD_COMMIT' };
  }
  try {
    const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    let gitDir = path.join(repoDir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!pointer) return { commit: null, source: 'unavailable' };
      gitDir = path.resolve(repoDir, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,64}$/.test(head)) return { commit: head, source: 'git:detached' };
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return { commit: null, source: 'unavailable' };
    const commonDir = fs.existsSync(path.join(gitDir, 'commondir'))
      ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
      : gitDir;
    for (const dir of [gitDir, commonDir]) {
      const refPath = path.join(dir, ref);
      if (fs.existsSync(refPath)) return { commit: fs.readFileSync(refPath, 'utf8').trim(), source: 'git:ref' };
    }
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
    const match = packed.split('\n').find((line) => line.endsWith(` ${ref}`));
    return { commit: match ? match.split(' ')[0] : null, source: match ? 'git:packed-ref' : 'unavailable' };
  } catch {
    return { commit: null, source: 'unavailable' };
  }
}

export interface HealthDependencies {
  getConfig: () => Promise<Record<string, unknown>>;
  runtimeIdentity: () => Promise<{ runtime_id?: string; remote_auth_state?: string }>;
  processManager: () => Promise<{ active: number; completed: number }>;
  searchEngine: () => Promise<{ ripgrepPath: string; activeSearches: number }>;
  managedTransport: () => Promise<{ mode: string; identity: string }>;
}

export async function collectHealth(deps: HealthDependencies): Promise<HealthReport> {
  let configHash: string | null = null;
  let allowlistHash: string | null = null;
  let allowedDirectories: string[] | null = null;

  const configuration = await runProbe(async () => {
    const config = await deps.getConfig();
    configHash = sha256Hex(strictCanonicalJsonV1(JSON.parse(JSON.stringify(config))));
    allowedDirectories = Array.isArray(config.allowedDirectories) ? (config.allowedDirectories as string[]) : [];
    const blocked = Array.isArray(config.blockedCommands) ? config.blockedCommands : [];
    allowlistHash = sha256Hex(strictCanonicalJsonV1({ allowedDirectories, blockedCommands: blocked }));
    return { status: 'ok', reason: 'configuration loaded', blockedCommandCount: blocked.length };
  });

  const subsystems: Record<string, SubsystemReport> = {
    configuration,
    runtime_identity: await runProbe(async () => {
      const identity = await deps.runtimeIdentity();
      return identity.runtime_id
        ? { status: 'ok', reason: 'runtime identity loaded', runtimeId: identity.runtime_id, remoteAuthState: identity.remote_auth_state ?? null }
        : { status: 'unhealthy', reason: 'runtime identity missing', errorCode: 'DC_SUBSYSTEM_UNAVAILABLE' };
    }),
    allowed_directories: await runProbe(async () => {
      if (allowedDirectories === null) return { status: 'unhealthy', reason: 'configuration unavailable', errorCode: 'DC_SUBSYSTEM_UNAVAILABLE' };
      if (allowedDirectories.length === 0) {
        return { status: 'ok', reason: 'no DC-level directory restriction configured (ACS containment governs managed calls)', unrestricted: true, count: 0 };
      }
      const missing = allowedDirectories.filter((dir) => !fs.existsSync(dir)).length;
      return missing === 0
        ? { status: 'ok', reason: 'all allowed directories present', unrestricted: false, count: allowedDirectories.length }
        : { status: 'degraded', reason: `${missing} allowed director${missing === 1 ? 'y is' : 'ies are'} missing`, errorCode: 'DC_PATH_NOT_FOUND', unrestricted: false, count: allowedDirectories.length };
    }),
    process_manager: await runProbe(async () => {
      const { active, completed } = await deps.processManager();
      return { status: 'ok', reason: 'process manager responsive', activeSessions: active, completedSessions: completed };
    }),
    search: await runProbe(async () => {
      const { ripgrepPath, activeSearches } = await deps.searchEngine();
      fs.accessSync(ripgrepPath, fs.constants.X_OK);
      return { status: 'ok', reason: 'ripgrep available', activeSearches };
    }),
    managed_transport: await runProbe(async () => {
      const { mode, identity } = await deps.managedTransport();
      if (mode === 'standalone') return { status: 'ok', reason: 'standalone mode (no managed transport)', mode };
      if (identity === 'active') return { status: 'ok', reason: 'ACS runtime identity handshake active', mode, identity };
      if (identity === 'drift' || identity === 'revoked') return { status: 'unhealthy', reason: `ACS runtime identity ${identity}`, mode, identity, errorCode: `ACS_RUNTIME_IDENTITY_${identity.toUpperCase()}` };
      return { status: 'degraded', reason: 'awaiting ACS runtime identity handshake', mode, identity };
    }),
    event_sinks: await runProbe(async () => {
      const sinks = executionEvents.sinkStatuses();
      const degraded = sinks.filter((sink) => sink.status !== 'ok');
      return degraded.length === 0
        ? { status: 'ok', reason: `${sinks.length} sink(s) healthy`, sinks }
        : { status: 'degraded', reason: `${degraded.length} sink(s) failing`, errorCode: degraded[0].lastErrorCode ?? 'SINK_WRITE_FAILED', sinks };
    }),
  };

  const statuses = Object.values(subsystems).map((entry) => entry.status);
  const status = statuses.includes('unhealthy') ? 'unhealthy' : statuses.includes('degraded') ? 'degraded' : 'healthy';
  return {
    status,
    version: VERSION,
    build: buildCommit(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    configHash,
    allowlistHash,
    subsystems,
  };
}
