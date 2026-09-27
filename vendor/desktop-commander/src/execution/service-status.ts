import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { DcToolError } from './errors.js';
import { whichExecutable } from './scope.js';
import { redactText } from './secret-scan.js';

/**
 * service_status: generic, read-only service inspection.
 *
 * No stack-specific knowledge: callers (Mission Control / ACS) decide which
 * probes matter. Probes are time-bounded, never mutate anything, never inject
 * credentials (no caller-supplied headers), and network probes are limited to
 * loopback/private addresses by default. The resolved address is pinned for
 * the connection (no DNS-rebinding window). Redirects are not followed.
 */
export type ServiceCheck =
  | { type: 'systemd_user' | 'systemd_system'; name: string }
  | { type: 'process'; pid?: number; name?: string }
  | { type: 'port'; host?: string; port: number }
  | { type: 'http'; url: string; expectStatus?: number }
  | { type: 'executable'; name: string };

export interface ServiceCheckResult {
  type: string;
  target: string;
  status: 'up' | 'down' | 'unknown' | 'error';
  latencyMs: number;
  detail: Record<string, unknown>;
  errorCode?: string;
}

const MAX_CHECKS = 25;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const UNIT_NAME = /^[A-Za-z0-9@._:\\-]{1,255}$/;
const PROCESS_NAME = /^[A-Za-z0-9@._+-]{1,64}$/;

export function isPrivateOrLoopback(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateOrLoopback(lower.slice(7));
    return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

async function resolveSafeHost(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const { address, family } = net.isIP(host) ? { address: host, family: net.isIP(host) as 4 | 6 } : await dns.lookup(host);
  if (!isPrivateOrLoopback(address) && process.env.DC_SERVICE_STATUS_ALLOW_PUBLIC !== '1') {
    throw new DcToolError('DC_INVALID_ARGUMENT', `refusing to probe non-private address ${address} (set DC_SERVICE_STATUS_ALLOW_PUBLIC=1 to allow)`, {
      stage: 'validate',
      ruleId: 'service_status.private_only',
    });
  }
  return { address, family: family as 4 | 6 };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', SYSTEMD_PAGER: '' } }, (error, stdout) => {
      resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : -1) : 0, stdout: String(stdout) });
    });
  });
}

async function systemdCheck(scope: 'user' | 'system', name: string, timeoutMs: number): Promise<Omit<ServiceCheckResult, 'latencyMs'>> {
  if (!UNIT_NAME.test(name)) throw new DcToolError('DC_INVALID_ARGUMENT', 'invalid systemd unit name', { stage: 'validate' });
  const unit = /\.(service|socket|timer|target|mount|path|scope|slice)$/.test(name) ? name : `${name}.service`;
  const args = [...(scope === 'user' ? ['--user'] : []), 'show', unit, '--no-pager', '--property=LoadState,ActiveState,SubState,MainPID,UnitFileState,ExecMainStartTimestamp,Result'];
  const { code, stdout } = await run('systemctl', args, timeoutMs);
  if (code !== 0) return { type: `systemd_${scope}`, target: unit, status: 'unknown', detail: {}, errorCode: 'DC_SUBSYSTEM_UNAVAILABLE' };
  const props = Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const status = props.LoadState === 'not-found' ? 'unknown' : props.ActiveState === 'active' ? 'up' : 'down';
  return { type: `systemd_${scope}`, target: unit, status, detail: { ...props, MainPID: Number(props.MainPID ?? 0) } };
}

async function processCheck(check: { pid?: number; name?: string }): Promise<Omit<ServiceCheckResult, 'latencyMs'>> {
  if (process.platform !== 'linux') return { type: 'process', target: String(check.pid ?? check.name), status: 'unknown', detail: {}, errorCode: 'DC_SUBSYSTEM_UNAVAILABLE' };
  const readStatus = async (pid: number) => {
    const text = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
    return { pid, name: field('Name'), state: field('State'), uid: Number(field('Uid')?.split(/\s+/)[0]), ownedByCurrentUser: Number(field('Uid')?.split(/\s+/)[0]) === process.getuid?.() };
  };
  if (check.pid !== undefined) {
    if (!Number.isSafeInteger(check.pid) || check.pid <= 0) throw new DcToolError('DC_INVALID_ARGUMENT', 'pid must be a positive integer', { stage: 'validate' });
    try {
      return { type: 'process', target: `pid:${check.pid}`, status: 'up', detail: await readStatus(check.pid) };
    } catch {
      return { type: 'process', target: `pid:${check.pid}`, status: 'down', detail: {} };
    }
  }
  if (!check.name || !PROCESS_NAME.test(check.name)) throw new DcToolError('DC_INVALID_ARGUMENT', 'process check needs a pid or a simple process name', { stage: 'validate' });
  const matches: unknown[] = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await fs.readFile(`/proc/${entry}/comm`, 'utf8')).trim() === check.name) {
        matches.push(await readStatus(Number(entry)));
        if (matches.length >= 20) break;
      }
    } catch {
      // process exited while scanning
    }
  }
  return { type: 'process', target: `name:${check.name}`, status: matches.length > 0 ? 'up' : 'down', detail: { count: matches.length, processes: matches } };
}

async function portCheck(host: string, port: number, timeoutMs: number): Promise<Omit<ServiceCheckResult, 'latencyMs'>> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DcToolError('DC_INVALID_ARGUMENT', 'port must be 1..65535', { stage: 'validate' });
  const { address } = await resolveSafeHost(host);
  const open = await new Promise<{ open: boolean; code?: string }>((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (result: { open: boolean; code?: string }) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done({ open: false, code: 'DC_TIMEOUT' }));
    socket.once('connect', () => done({ open: true }));
    socket.once('error', (error: NodeJS.ErrnoException) => done({ open: false, code: error.code }));
  });
  return { type: 'port', target: `${host}:${port}`, status: open.open ? 'up' : 'down', detail: { address, ...(open.code ? { reason: open.code } : {}) } };
}

async function httpCheck(rawUrl: string, expectStatus: number | undefined, timeoutMs: number): Promise<Omit<ServiceCheckResult, 'latencyMs'>> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'url is not a valid URL', { stage: 'validate' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DcToolError('DC_INVALID_ARGUMENT', 'only http(s) URLs are supported', { stage: 'validate' });
  if (url.username || url.password) throw new DcToolError('DC_INVALID_ARGUMENT', 'credentials in URLs are not accepted', { stage: 'validate', ruleId: 'service_status.no_credentials' });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const { address, family } = await resolveSafeHost(hostname);
  const client = url.protocol === 'https:' ? https : http;
  const outcome = await new Promise<{ statusCode?: number; contentType?: string; body?: string; code?: string }>((resolveOnce) => {
    // `timeout` below is only a socket-INACTIVITY timeout: a trickling body
    // keeps resetting it. The absolute deadline bounds the whole probe.
    let settled = false;
    const resolve = (value: { statusCode?: number; contentType?: string; body?: string; code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveOnce(value);
    };
    const deadline = setTimeout(() => {
      req.destroy();
      resolve({ code: 'DC_TIMEOUT' });
    }, timeoutMs);
    const req = client.request({
      method: 'GET',
      host: hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: { 'user-agent': 'desktop-commander-service-status', accept: '*/*' },
      // Pin the validated address: no second DNS resolution.
      lookup: (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, address, family),
      timeout: timeoutMs,
    } as http.RequestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < 4_096) { chunks.push(chunk); size += chunk.length; }
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8').slice(0, 512) }));
      res.on('error', () => resolve({ statusCode: res.statusCode, code: 'RESPONSE_ERROR' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ code: 'DC_TIMEOUT' }); });
    req.on('error', (error: NodeJS.ErrnoException) => resolve({ code: error.code ?? 'REQUEST_ERROR' }));
    req.end();
  });
  if (outcome.statusCode === undefined) return { type: 'http', target: url.origin + url.pathname, status: 'down', detail: { address, reason: outcome.code } };
  const healthy = expectStatus !== undefined ? outcome.statusCode === expectStatus : outcome.statusCode >= 200 && outcome.statusCode < 400;
  return {
    type: 'http',
    target: url.origin + url.pathname,
    status: healthy ? 'up' : 'down',
    detail: { address, statusCode: outcome.statusCode, contentType: outcome.contentType, bodySnippet: redactText(outcome.body ?? '') },
  };
}

export async function serviceStatus(input: { checks: unknown; timeoutMs?: unknown }) {
  if (!Array.isArray(input.checks) || input.checks.length === 0 || input.checks.length > MAX_CHECKS) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `checks must be a non-empty array of at most ${MAX_CHECKS} probes`, { stage: 'validate' });
  }
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `timeoutMs must be an integer between 100 and ${MAX_TIMEOUT_MS}`, { stage: 'validate' });
  }
  const results = await Promise.all((input.checks as ServiceCheck[]).map(async (check): Promise<ServiceCheckResult> => {
    const started = Date.now();
    try {
      let partial: Omit<ServiceCheckResult, 'latencyMs'>;
      switch (check?.type) {
        case 'systemd_user': partial = await systemdCheck('user', (check as any).name, timeoutMs); break;
        case 'systemd_system': partial = await systemdCheck('system', (check as any).name, timeoutMs); break;
        case 'process': partial = await processCheck(check as any); break;
        case 'port':
        case 'http':
          if (process.env.DC_NETWORK_PROFILE === 'none') {
            // Honour the operator's existing no-network profile for the
            // network-touching probes (systemd/process/executable stay available).
            throw new DcToolError('DC_COMMAND_FORBIDDEN', `${check.type} probes are disabled by DC_NETWORK_PROFILE=none`, { stage: 'validate', ruleId: 'network_profile.none' });
          }
          partial = check.type === 'port'
            ? await portCheck((check as any).host ?? '127.0.0.1', (check as any).port, timeoutMs)
            : await httpCheck((check as any).url, (check as any).expectStatus, timeoutMs);
          break;
        case 'executable': {
          const name = (check as any).name;
          if (typeof name !== 'string' || !PROCESS_NAME.test(name)) throw new DcToolError('DC_INVALID_ARGUMENT', 'executable name must be a simple command name', { stage: 'validate' });
          const found = await whichExecutable(name);
          partial = { type: 'executable', target: name, status: found ? 'up' : 'down', detail: { path: found } };
          break;
        }
        default:
          throw new DcToolError('DC_INVALID_ARGUMENT', `unsupported check type: ${String((check as any)?.type)}`, { stage: 'validate' });
      }
      return { ...partial, latencyMs: Date.now() - started };
    } catch (error) {
      const code = error instanceof DcToolError ? error.dcCode : 'DC_INTERNAL_ERROR';
      return { type: String((check as any)?.type), target: '', status: 'error', latencyMs: Date.now() - started, detail: { message: error instanceof Error ? redactText(error.message) : 'error' }, errorCode: code };
    }
  }));
  const summary = { up: 0, down: 0, unknown: 0, error: 0 };
  for (const r of results) summary[r.status] += 1;
  return { schema: 'dc.service-status.v1', readOnly: true, summary, results };
}
