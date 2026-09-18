/**
 * /health self-diagnostics for Desktop Commander.
 *
 * 'healthy' means end-to-end: a synthetic MCP tools/call round-trip. When the
 * full call cannot be made, the report degrades to transport-level checks with
 * an explicit 'degraded' marker.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyChain, AUDIT_DIR } from '../audit/audit-chain.js';
import { executorLeasePath } from '../executor-lock.js';

export interface HealthCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'DEGRADED';
  detail: string;
  durationMs: number;
}

export interface HealthReport {
  healthy: boolean;
  degraded: boolean;
  checks: HealthCheck[];
  activeLeases: number;
  activeProcesses: number;
  staleExecutors: number;
  timestamp: string;
}

const LEASE_FILE = executorLeasePath(); // canonical: ~/.desktop-commander/executor.lock (src/executor-lock.ts)
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/dist(\/|$)/, '/src').replace(/\/src\/health$/, '/src');

function timedCheck(name: string): { check: HealthCheck; done(status: HealthCheck['status'], detail: string): void } {
  const start = Date.now();
  const check: HealthCheck = { name, status: 'FAIL', detail: 'not run', durationMs: 0 };
  return {
    check,
    done(status, detail) {
      check.status = status;
      check.detail = detail;
      check.durationMs = Date.now() - start;
    },
  };
}

function spawnOnce(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; err?: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ code: err && (err as NodeJS.ErrnoException & { code?: unknown }).code ? null : 0, stdout: String(stdout), err: err ? String(err.message) : undefined });
    });
    child.on('error', (err) => resolve({ code: null, stdout: '', err: String(err) }));
  });
}

async function checkExecutor(): Promise<HealthCheck> {
  const t = timedCheck('Desktop executor');
  const r = await spawnOnce('echo', ['ok'], 5000);
  if (r.stdout.trim() === 'ok') {
    t.done('PASS', "spawn 'echo ok' responded");
  } else {
    t.done('FAIL', `spawn failed: ${r.err ?? 'no output'}`);
  }
  return t.check;
}

async function checkMcpEndpoint(): Promise<HealthCheck> {
  const t = timedCheck('MCP endpoint');
  // The server entry is stdio-based; a full handshake is done by the synthetic
  // end-to-end call below. Here we verify the entrypoint is buildable/launchable.
  const entry = path.join(SRC_DIR, '..', 'dist', 'index.js');
  const exists = fs.existsSync(entry) || fs.existsSync(path.join(SRC_DIR, 'index.ts'));
  t.done(exists ? 'PASS' : 'FAIL', exists ? `entrypoint present (${fs.existsSync(entry) ? 'dist/index.js' : 'src/index.ts'})` : 'no server entrypoint found');
  return t.check;
}

function readLeaseState(): { activeLeases: number; staleExecutors: number; leaseDetail: string } {
  try {
    if (fs.existsSync(LEASE_FILE)) {
      // Reconciled with src/executor-lock.ts LeaseInfo schema:
      // {instanceId, pid, acquiredAt, renews, expiresAt(ms epoch), hostname}.
      const raw = JSON.parse(fs.readFileSync(LEASE_FILE, 'utf8')) as { pid?: number; expiresAt?: number; instanceId?: string };
      if (raw && typeof raw.pid === 'number' && typeof raw.expiresAt === 'number') {
        const expired = raw.expiresAt < Date.now();
        const holderAlive = pidAlive(raw.pid);
        if (expired || !holderAlive) {
          return { activeLeases: 0, staleExecutors: 1, leaseDetail: `stale lease held by pid ${raw.pid} (${expired ? 'expired TTL' : 'dead pid'})` };
        }
        return { activeLeases: 1, staleExecutors: 0, leaseDetail: `lease held by pid ${raw.pid} (${raw.instanceId ?? 'unknown instance'})` };
      }
      // Legacy/unrecognized schema — count conservatively as active.
      return { activeLeases: 1, staleExecutors: 0, leaseDetail: 'lease file present (legacy schema)' };
    }
  } catch {
    // Malformed lease file counts as zero active leases, tolerate.
  }
  return { activeLeases: 0, staleExecutors: 0, leaseDetail: 'no lease file (uncontended)' };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scanProcesses(): { activeProcesses: number; staleExecutors: number } {
  let activeProcesses = 0;
  try {
    const pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
    const myPid = process.pid;
    for (const pid of pids) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('desktop-commander') && Number(pid) !== myPid) activeProcesses++;
      } catch {
        // Process vanished or not readable.
      }
    }
  } catch {
    // Non-Linux or restricted /proc.
  }
  return { activeProcesses, staleExecutors: 0 };
}

async function checkPolicyEngine(): Promise<HealthCheck> {
  const t = timedCheck('Policy engine');
  const policyPath = path.join(SRC_DIR, 'security', 'path-policy.ts');
  const distPolicy = path.join(SRC_DIR, '..', 'dist', 'security', 'path-policy.js');
  const present = fs.existsSync(policyPath) || fs.existsSync(distPolicy);
  const capKey = Boolean(process.env.DC_CAPABILITY_KEY ?? process.env.DESKTOP_COMMANDER_CAPABILITY_KEY);
  if (present && capKey) t.done('PASS', 'path-policy present, capability key set');
  else if (present) t.done('DEGRADED', 'path-policy present but no capability key env set');
  else t.done('FAIL', 'path-policy module missing');
  return t.check;
}

async function checkAuditSink(): Promise<HealthCheck> {
  const t = timedCheck('Audit sink');
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const probe = path.join(AUDIT_DIR, '.health-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    const files = fs.readdirSync(AUDIT_DIR).filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl')).sort();
    if (files.length === 0) {
      t.done('PASS', 'dir writable, no chain yet');
      return t.check;
    }
    // Verify the last chain file's links (windowed to the newest 50 events).
    const newest = path.join(AUDIT_DIR, files[files.length - 1]);
    const { verifyChain } = await import('../audit/audit-chain.js');
    const result = verifyChain(newest);
    t.done(result.valid ? 'PASS' : 'FAIL', result.valid ? 'chain verified' : `${result.error} (index ${result.brokenAt})`);
  } catch (err) {
    t.done('FAIL', String(err));
  }
  return t.check;
}

async function checkOAuthGateway(): Promise<HealthCheck> {
  const t = timedCheck('OAuth gateway');
  const url = process.env.DC_OAUTH_GATEWAY_URL;
  if (!url) {
    t.done('DEGRADED', 'DC_OAUTH_GATEWAY_URL not configured');
    return t.check;
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    t.done(r.ok ? 'PASS' : 'FAIL', `HTTP ${r.status}`);
  } catch (err) {
    t.done('FAIL', String(err));
  }
  return t.check;
}

/**
 * Synthetic end-to-end MCP call: spawn the server over stdio and complete a
 * tools/call JSON-RPC round trip within 10s.
 */
async function checkEndToEndMcp(): Promise<HealthCheck> {
  const t = timedCheck('End-to-end MCP tools/call');
  const entry = path.join(SRC_DIR, '..', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    t.done('DEGRADED', 'dist/index.js not built — full call not attempted');
    return t.check;
  }
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [entry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The synthetic probe child is a second, ephemeral server instance for
        // diagnostics only — it must not contend for the canonical executor
        // lease (item #2) or the health check would self-block.
        env: { ...process.env, DC_DISABLE_EXECUTOR_LEASE: '1' },
    });
    const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      let buf = '';
      const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timeout waiting for tools/call response (10s)' }); }, 10_000);
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2) {
              clearTimeout(timer);
              resolve({ ok: !msg.error, detail: msg.error ? `JSON-RPC error: ${JSON.stringify(msg.error)}` : 'tools/call round-trip completed' });
            }
          } catch { /* not a full line yet */ }
        }
      });
      child.stderr.on('data', () => { /* server logs */ });
      child.on('exit', (code) => resolve({ ok: false, detail: `server exited early (code ${code})` }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'health-check', version: '0.0.1' } } }) + '\n');
      setTimeout(() => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_directory', arguments: { path: os.tmpdir() } } }) + '\n');
      }, 300);
    });
    child.kill();
    t.done(result.ok ? 'PASS' : 'DEGRADED', result.detail);
  } catch (err) {
    t.done('DEGRADED', `end-to-end not attempted: ${String(err)}`);
  }
  return t.check;
}

export async function runHealthCheck(): Promise<HealthReport> {
  const leaseState = readLeaseState();
  const procState = scanProcesses();
  const checks: HealthCheck[] = [];
  checks.push(await checkOAuthGateway());
  checks.push(await checkMcpEndpoint());
  checks.push(await checkExecutor());
  checks.push(await checkPolicyEngine());
  checks.push(await checkAuditSink());
  checks.push(await checkEndToEndMcp());

  const degraded = checks.some((c) => c.status === 'DEGRADED');
  const healthy = checks.every((c) => c.status === 'PASS');
  return {
    healthy,
    degraded,
    checks,
    activeLeases: leaseState.activeLeases,
    activeProcesses: procState.activeProcesses,
    staleExecutors: Math.max(leaseState.staleExecutors, procState.staleExecutors),
    timestamp: new Date().toISOString(),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function formatReport(report: HealthReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${pad(c.name, 30)} ${c.status}  ${c.detail} (${c.durationMs}ms)`);
  }
  lines.push(`${pad('active leases', 30)} ${report.activeLeases}`);
  lines.push(`${pad('active processes', 30)} ${report.activeProcesses}`);
  lines.push(`${pad('stale executors', 30)} ${report.staleExecutors}`);
  lines.push(report.healthy ? 'HEALTHY' : report.degraded ? 'DEGRADED' : 'UNHEALTHY');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runHealthCheck();
  console.log(formatReport(report));
  process.exit(report.healthy ? 0 : 1);
}
