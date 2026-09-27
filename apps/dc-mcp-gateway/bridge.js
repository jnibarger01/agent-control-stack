#!/usr/bin/env node
/**
 * stdio -> Streamable HTTP MCP multiplexer for Desktop Commander.
 *
 * There is exactly one upstream StdioClientTransport (and therefore one
 * Desktop Commander executor). Each downstream HTTP client gets its own
 * StreamableHTTPServerTransport and gateway session record. The gateway
 * rewrites request ids at the shared-upstream boundary so independent clients
 * may reuse JSON-RPC ids without response crossover.
 */
import http from 'node:http';
import { randomUUID, webcrypto, createHmac, timingSafeEqual } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACS_CAPABILITY_META_KEY = 'capability';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PORT = parseInt(process.env.BRIDGE_PORT || '8002', 10);
// Explicit ACS managed mode: the executor is started WITHOUT --standalone;
// authority comes only from ACS-issued capabilities transported by the
// authenticated gateway. A configured --standalone argument in managed mode
// is refused outright (never silently stripped) so no legacy execution path
// can exist on the managed lane.
const MANAGED = process.env.ACS_MANAGED_MODE === '1';
// BRIDGE_PROFILE=jace-commander runs the Jace Commander MCP child
// (desktop-commander dist/jace-commander/cli.js) behind /jc/mcp instead of
// Desktop Commander. It is always managed: the child rejects every call that
// lacks an ACS acs.jc.v1 capability, and privileged_exec is re-verified by the
// root helper regardless.
const PROFILE = process.env.BRIDGE_PROFILE || 'desktop-commander';
if (PROFILE !== 'desktop-commander' && PROFILE !== 'jace-commander') {
  console.error(`bridge: unknown BRIDGE_PROFILE ${PROFILE}; refusing to start`);
  process.exit(1);
}
const JC = PROFILE === 'jace-commander';
if (JC && !MANAGED) {
  console.error('bridge: BRIDGE_PROFILE=jace-commander requires ACS_MANAGED_MODE=1; refusing to start');
  process.exit(1);
}
const DC_CMD = process.env.DC_CMD || '/home/linuxbrew/.linuxbrew/bin/node';
const DEFAULT_DC_ARGS = JC
  ? '/home/jacen/projects/desktop-commander/dist/jace-commander/cli.js serve'
  : MANAGED
    ? '/home/jacen/projects/desktop-commander/dist/index.js'
    : '/home/jacen/projects/desktop-commander/dist/index.js --standalone';
const DC_ARGS = (process.env.DC_ARGS || DEFAULT_DC_ARGS).split(' ');
if (MANAGED && DC_ARGS.includes('--standalone')) {
  console.error('bridge: managed mode refuses a --standalone executor; fix DC_ARGS');
  process.exit(1);
}
const DC_CWD = process.env.DC_CWD || '/home/jacen/projects/desktop-commander';
const EXECUTION_TOKEN = process.env.DC_GATEWAY_EXECUTION_TOKEN || '';
const GATEWAY_ATTESTATION_KEY = process.env.DC_GATEWAY_ATTESTATION_KEY || '';
const PIPELINE_ACS_PUBLIC_KEY = process.env.DC_ACS_CAPABILITY_PUBLIC_KEY || '';
const PIPELINE_ACS_KEY_ID = process.env.DC_ACS_CAPABILITY_KEY_ID || '';
// ACS capability verification material for the native managed child. The child
// gets PUBLIC verification keys only; the ACS signing key never leaves ACS.
const ACS_DC_PUBLIC_KEY = process.env.ACS_DC_PUBLIC_KEY || '';
const ACS_DC_KEY_ID = process.env.ACS_DC_KEY_ID || '';
const ACS_DC_SCOPES = process.env.ACS_DC_RUNTIME_SCOPES || 'fs.read,fs.write,process.exec,process.spawn';
// Jace Commander child configuration: public verification material and
// integration endpoints only. Explicit allowlist; nothing else is inherited.
const JC_CHILD_ENV_KEYS = [
  'JC_ACS_PUBLIC_KEY', 'JC_ACS_KEY_ID', 'JC_RUNTIME_ID', 'JC_STATE_DIR', 'JC_PUBLIC_MCP_URL',
  'JC_ACS_URL', 'JC_ACS_TOKEN', 'JC_SWARM_URL', 'JC_SWARM_TOKEN', 'JC_VISUALIZER_URL',
  'JC_MISSION_ROUTER_DIR', 'JC_TRACE_ROOTS', 'JC_PRIVILEGED_HELPER', 'JC_SUDO_PATH', 'JC_REQUEST_TIMEOUT_MS',
];
if (JC && (!process.env.JC_ACS_PUBLIC_KEY || !process.env.JC_ACS_KEY_ID || !process.env.JC_RUNTIME_ID)) {
  console.error('bridge: jace-commander profile requires JC_ACS_PUBLIC_KEY, JC_ACS_KEY_ID and JC_RUNTIME_ID; refusing to start');
  process.exit(1);
}
const CHILD_ENV = {
  PATH: process.env.PATH || '',
  HOME: process.env.HOME || '',
  LANG: process.env.LANG || 'C.UTF-8',
  TMPDIR: process.env.TMPDIR || '/tmp',
  NODE_ENV: process.env.NODE_ENV || 'production',
  ...(GATEWAY_ATTESTATION_KEY ? { DC_GATEWAY_ATTESTATION_KEY: GATEWAY_ATTESTATION_KEY } : {}),
  ...(PIPELINE_ACS_PUBLIC_KEY
    ? {
        DC_ACS_CAPABILITY_PUBLIC_KEY: PIPELINE_ACS_PUBLIC_KEY,
        ...(PIPELINE_ACS_KEY_ID ? { DC_ACS_CAPABILITY_KEY_ID: PIPELINE_ACS_KEY_ID } : {}),
      }
    : {}),
  ...(process.env.DESKTOP_COMMANDER_STATE_DIR ? { DESKTOP_COMMANDER_STATE_DIR: process.env.DESKTOP_COMMANDER_STATE_DIR } : {}),
  ...(process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR ? { DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR } : {}),
  ...(JC
    ? Object.fromEntries(JC_CHILD_ENV_KEYS.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
    : {}),
  ...(!JC && MANAGED && ACS_DC_PUBLIC_KEY && ACS_DC_KEY_ID
    ? {
        DESKTOP_COMMANDER_ACS_PUBLIC_KEY: ACS_DC_PUBLIC_KEY,
        DESKTOP_COMMANDER_ACS_KEY_ID: ACS_DC_KEY_ID,
        DESKTOP_COMMANDER_ACS_SCOPES: ACS_DC_SCOPES,
        DC_ACS_CAPABILITY_PUBLIC_KEY: ACS_DC_PUBLIC_KEY,
        DC_ACS_CAPABILITY_KEY_ID: ACS_DC_KEY_ID,
      }
    : {}),
};
if (!JC && MANAGED && (!ACS_DC_PUBLIC_KEY || !ACS_DC_KEY_ID)) {
  console.error('bridge: managed mode requires ACS_DC_PUBLIC_KEY and ACS_DC_KEY_ID; refusing to start');
  process.exit(1);
}
// Canonical result submission: after each governed tool call completes, the
// bridge reports the outcome back to ACS bound to the capability's attempt and
// lease. ACS remains the sole owner of canonical result state; the bridge only
// reports what it observed. Submission failures never alter the tool result
// delivered to the client; ACS's lease-expiry reconciliation still wins.
const ACS_BASE_URL = (process.env.ACS_GATEWAY_URL || '').replace(/\/+$/, '');
const ACS_WORKER_TOKEN = process.env.ACS_WORKER_TOKEN || '';
const ACS_WORKER_ID = process.env.ACS_WORKER_ID || 'acs-dc-bridge';
const MAX_BODY = 2 * 1024 * 1024;

let pair = null; // { upstream, sessions, routes, initTail, initializedOnce }
let spawnCount = 0;
let lastDebug = { last_headers: null, last_upstream_message: null };
let shuttingDown = false;

function idKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }
function hasId(msg) { return Object.prototype.hasOwnProperty.call(msg, 'id'); }
function isRequest(msg) { return hasId(msg) && typeof msg.method === 'string'; }
function isNotification(msg) { return !hasId(msg) && typeof msg.method === 'string'; }
function isResponse(msg) { return hasId(msg) && !isRequest(msg) && (msg.result !== undefined || msg.error !== undefined); }
function isInitialize(msg) { return msg?.method === 'initialize'; }

function verifyAttestation(value, agentHeader) {
  try {
    const [body, sig] = String(value).split('.');
    if (!body || !sig) return null;
    const expect = createHmac('sha256', EXECUTION_TOKEN).update(body).digest('base64url');
    const a = Buffer.from(sig); const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const t = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < t) return null;
    if (typeof payload.iat === 'number' && payload.exp - payload.iat > 60) return null;
    if (agentHeader && payload.sub !== agentHeader) return null;
    return payload;
  } catch { return null; }
}

function injectAttestation(msg, headers) {
  if (!EXECUTION_TOKEN) return msg;
  const att = headers['x-dc-attestation'];
  if (!att) return msg; // local loopback callers retain legacy pass-through behavior
  const payload = verifyAttestation(att, headers['x-dc-agent']);
  if (!payload) return msg; // HTTP layer rejects before this point
  const agent = String(payload.sub || '');
  const sub = String(payload.sub || '');
  const clientId = String(payload.client_id || '');
  const jti = String(payload.jti || '');
  const iat = Date.now();
  const material = `${sub}.${clientId}.${jti}.${iat}`;
  const sig = createHmac('sha256', EXECUTION_TOKEN).update(material).digest('base64url');
  const meta = { ...(msg.params?._meta || {}) };
  meta.agent = agent.startsWith('chatgpt:') ? agent : `chatgpt:${agent}`;
  // Force-overwrite client-writable provenance fields. Desktop Commander
  // independently verifies this HMAC before trusting gateway identity.
  meta.gateway = { verified: true, sub, client_id: clientId, jti, iat, sig };
  meta.transport = 'oauth-gateway';
  msg.params = { ...(msg.params || {}), _meta: meta };
  return msg;
}

/** Canonical attempt-bound idempotency key (stableHash over sorted-key JSON). */
function attemptResultIdempotencyKey(attemptId) {
  return createHash('sha256')
    .update(`{"attemptId":"${attemptId}","domain":"acs.attempt-result.v1"}`)
    .digest('hex');
}

/**
 * Submit the canonical result for a governed tool call to ACS. Bound to the
 * capability's real attempt/lease/fencing authority; ACS validates everything
 * and owns the resulting state transition. Fire-and-forget: the client result
 * is unaffected, and ACS lease-expiry reconciliation remains authoritative if
 * submission fails.
 */
async function submitAcsResult(route, msg) {
  // jc attempts have no ACS result contract yet; the root helper's audit chain
  // is the execution evidence. Never post DC-shaped results for jc calls.
  if (JC) return;
  if (!ACS_BASE_URL || !ACS_WORKER_TOKEN || !route?.capability) return;
  const payload = route.capability?.payload;
  if (!payload || typeof msg.result !== 'object' || msg.result === null) return;
  const isError = msg.result.isError === true;
  const texts = Array.isArray(msg.result?.content)
    ? msg.result.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
    : [];
  const summary = (isError ? texts.join('\n') : texts.join('\n') || 'ok').slice(0, 2000);
  const body = {
    workItemId: payload.workItemId,
    attemptId: payload.attemptId,
    leaseId: payload.leaseId,
    workerId: route.leaseBinding?.workerId || ACS_WORKER_ID,
    actionHash: route.leaseBinding?.claimActionHash || payload.actionHash,
    planHash: payload.planHash,
    inputHash: route.leaseBinding?.inputHash || route.inputHash,
    fencingEpoch: payload.leaseEpoch,
    idempotencyKey: attemptResultIdempotencyKey(payload.attemptId),
    outcome: isError ? 'failed' : 'succeeded',
    startedAt: route.startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    summary: isError ? `tool failed: ${summary}` : summary,
    structuredOutput: {},
    artifacts: [],
    ...(isError ? { error: summary.slice(0, 4000) } : {}),
    simulationMetadata: {
      executionMode: 'desktop_commander',
      simulated: false,
      backend: 'desktop-commander-mcp',
      toolName: payload.toolName,
      invocationFingerprint: payload.invocationHash,
      requestId: payload.attemptId,
    },
  };
  try {
    const url = new URL(`/work-items/${encodeURIComponent(payload.workItemId)}/results`, ACS_BASE_URL);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACS_WORKER_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`bridge: ACS result submission declined (HTTP ${res.status})`);
    else console.log(`bridge: ACS result submitted for attempt ${payload.attemptId}`);
  } catch (error) {
    console.error(`bridge: ACS result submission failed: ${error?.message}`);
  }
}

function sendJsonRpcError(res, status, code, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function failClosed(reason, target = pair) {
  console.error(`bridge: fail-closed upstream routing fault: ${reason}`);
  if (!target) return;
  for (const session of target.sessions.values()) {
    session.initializeResolve?.(false);
    session.closed = true;
    session.transport.close().catch(() => {});
  }
  target.sessions.clear(); target.routes.clear();
}

/**
 * Every downstream session receives a fresh ACS bootstrap challenge. The stdio
 * Desktop Commander server can process repeated initialize requests, so keep
 * the canonical executor alive and serialize those handshakes through it.
 * This preserves challenge freshness without invalidating already-live HTTP
 * sessions or creating an executor recycle storm.
 */
async function forwardInitialize(session, msg, outbound) {
  if (session.closed || !pair || pair !== session.pair) return;
  const target = pair;
  const key = idKey(msg.id);
  if (session.pending.has(key)) {
    failClosed(`duplicate downstream initialize id in session ${session.id}`, target);
    return;
  }

  const upstreamId = `gw-init-${randomUUID()}`;
  const expectedChallenge = msg?.params?._meta?.acsRuntimeBootstrap?.challenge;
  const completion = new Promise((resolve) => { session.initializeResolve = resolve; });
  session.initializePromise = completion;

  const run = async () => {
    if (session.closed || target !== pair || session.pair !== target) {
      session.initializeResolve?.(false);
      return false;
    }
    target.routes.set(upstreamId, {
      session,
      downstreamId: msg.id,
      initialize: true,
      expectedChallenge,
    });
    session.pending.set(key, upstreamId);
    outbound.id = upstreamId;
    await target.startPromise;
    if (session.closed || target !== pair || session.pair !== target) {
      target.routes.delete(upstreamId);
      session.pending.delete(key);
      session.initializeResolve?.(false);
      return false;
    }
    try {
      await target.upstream.send(outbound);
    } catch (error) {
      target.routes.delete(upstreamId);
      session.pending.delete(key);
      session.initializeResolve?.(false);
      throw error;
    }
    return completion;
  };

  const turn = target.initTail.then(run, run);
  target.initTail = turn.catch(() => false);
  return turn;
}

async function forward(session, msg, headers) {
  if (session.closed) return;
  if (isInitialize(msg)) {
    const outbound = injectAttestation(structuredClone(msg), headers);
    lastDebug = { last_headers: headers, last_upstream_message: outbound };
    return forwardInitialize(session, msg, outbound);
  }
  if (!pair || pair !== session.pair) return;
  const outbound = injectAttestation(structuredClone(msg), headers);
  lastDebug = { last_headers: headers, last_upstream_message: outbound };

  if (isResponse(msg)) { failClosed(`downstream response has no deterministic server-request route (${String(msg.id)})`, session.pair); return; }
  if (!isRequest(msg) && !isNotification(msg)) { failClosed('malformed message after SDK validation', session.pair); return; }
  if (session.initializePromise) await session.initializePromise;
  if (!session.upstreamInitialized || session.closed || pair !== session.pair) return;
  if (isNotification(msg)) { await pair.upstream.send(outbound); return; }

  const key = idKey(msg.id);
  if (session.pending.has(key)) { failClosed(`duplicate downstream request id in session ${session.id}`, session.pair); return; }
  const upstreamId = `gw-${randomUUID()}`;
  session.pending.set(key, upstreamId);
  const governed = outbound.params && typeof outbound.params._meta === 'object' && outbound.params._meta !== null
    ? outbound.params._meta[ACS_CAPABILITY_META_KEY]
    : undefined;
  pair.routes.set(upstreamId, {
    session, downstreamId: msg.id, initialize: false,
    ...(governed ? { capability: governed, startedAt: new Date().toISOString(), leaseBinding: outbound.params._meta.acsLeaseBinding } : {}),
  });
  outbound.id = upstreamId;
  try { await pair.upstream.send(outbound); }
  catch (error) { pair.routes.delete(upstreamId); session.pending.delete(key); throw error; }
}

function spawnPair() {
  // The MCP SDK otherwise supplies a minimal default environment to stdio
  // children. Pass the bridge environment explicitly so Desktop Commander
  // receives the configured gateway-HMAC and ACS public verification keys.
  const upstream = new StdioClientTransport({
    command: DC_CMD,
    args: DC_ARGS,
    cwd: DC_CWD,
    stderr: 'inherit',
    // Explicit allowlist: the managed child receives PATH/HOME/LANG/TMPDIR
    // (plus DESKTOP_COMMANDER_STATE_DIR when set) and only the ACS PUBLIC
    // verification material — never the full parent environment.
    env: CHILD_ENV,
  });
  const next = {
    upstream,
    sessions: new Map(),
    routes: new Map(),
    initTail: Promise.resolve(),
    initializedOnce: false,
  };
  upstream.onmessage = async (msg) => {
    if (isResponse(msg)) {
      const route = next.routes.get(String(msg.id));
      if (!route || !route.session) return failClosed(`orphan upstream response ${String(msg.id)}`, next);
      next.routes.delete(String(msg.id));
      route.session.pending.delete(idKey(route.downstreamId));
      if (route.session.closed) {
        if (route.initialize) route.session.initializeResolve?.(false);
        return;
      }

      const response = { ...msg, id: route.downstreamId };
      if (route.initialize) {
        const proofChallenge = response?.result?._meta?.acsRuntimeIdentity?.challenge;
        if (route.expectedChallenge && proofChallenge !== route.expectedChallenge) {
          console.error('bridge: managed initialize proof challenge mismatch; rejecting session without recycling executor');
          try {
            await route.session.transport.send({
              jsonrpc: '2.0',
              id: route.downstreamId,
              error: { code: -32002, message: 'managed runtime identity challenge mismatch' },
            });
          } catch (error) {
            failClosed(`downstream initialize rejection delivery failed: ${error.message}`, next);
          }
          route.session.initializeResolve?.(false);
          return;
        }
        next.initializedOnce = true;
      }

      try { await route.session.transport.send(response); }
      catch (error) {
        if (route.initialize) route.session.initializeResolve?.(false);
        failClosed(`downstream response delivery failed: ${error.message}`, next);
        return;
      }
      if (route.initialize && !route.session.closed) {
        route.session.upstreamInitialized = true;
        route.session.initializeResolve?.(true);
      }
      if (route.capability) {
        submitAcsResult(route, msg).catch(() => {});
      }
      return;
    }
    if (hasId(msg) && typeof msg.method === 'string') return failClosed(`unsupported upstream server request ${String(msg.method)}`, next);
    for (const session of next.sessions.values()) if (!session.closed) session.transport.send(msg).catch(() => {});
  };
  upstream.onerror = (e) => console.error('bridge: upstream error:', e?.message);
  upstream.onclose = () => {
    console.error('bridge: upstream closed');
    if (pair === next) {
      failClosed('upstream closed', next);
      if (!shuttingDown) spawnPair();
    }
  };
  next.startPromise = upstream.start().catch((e) => { console.error('bridge: upstream start failed:', e?.message); process.exit(1); });
  spawnCount++; pair = next;
  console.log(`bridge: Desktop Commander stdio executor started (spawn_count=${spawnCount})`);
  return next;
}

function createSession(headers) {
  const session = {
    id: null,
    pair,
    transport: null,
    pending: new Map(),
    closed: false,
    initialized: false,
    upstreamInitialized: false,
    initializePromise: null,
    initializeResolve: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    metadata: { client: headers['user-agent'] || null },
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(), enableJsonResponse: false,
    onsessioninitialized: (sid) => {
      if (pair !== session.pair || session.pair.sessions.has(sid)) throw new Error('ambiguous downstream session ownership');
      session.id = sid; session.initialized = true; session.lastActivityAt = Date.now(); session.pair.sessions.set(sid, session);
    },
    onsessionclosed: (sid) => {
      if (session.pair.sessions.get(sid) === session) session.pair.sessions.delete(sid);
      session.closed = true;
      session.initializeResolve?.(false);
      for (const upstreamId of session.pending.values()) session.pair.routes.delete(upstreamId);
      session.pending.clear();
    },
  });
  session.transport = transport;
  transport.onmessage = (msg, extra) => {
    session.lastActivityAt = Date.now();
    const requestHeaders = extra?.requestInfo?.headers || headers;
    session.metadata.protocolVersion = msg.params?.protocolVersion || session.metadata.protocolVersion;
    forward(session, msg, requestHeaders)
      .catch((error) => { console.error('bridge: send->stdio failed:', error?.message); failClosed('upstream forwarding failure'); });
  };
  transport.onerror = (e) => console.error('bridge: downstream transport error:', e?.message);
  return session;
}

spawnPair();
console.log(`bridge: executor mode: ${MANAGED ? 'managed (ACS-authorized capabilities only)' : 'standalone'}`);

// --- /health, /ready, /authority (hardening item #2) -----------------------
// Non-secret introspection only: no capability payloads, HMAC/Ed25519 key
// material, tokens, or credentials are ever included in these responses.
function dcStateDir() {
  const override = process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR;
  return override && override.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), '.desktop-commander');
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return !!(err && err.code === 'EPERM'); }
}
function readJsonLease(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/** Fail closed: a present-but-unparsable lease/marker reports active+ambiguous, never inactive. */
function leaseStatus(file, label) {
  if (!fs.existsSync(file)) return { active: false, ambiguous: false, detail: `no ${label} file` };
  const info = readJsonLease(file);
  if (!info || typeof info.pid !== 'number') return { active: true, ambiguous: true, detail: `${label} file present but unreadable/malformed: ${file}` };
  if (!isPidAlive(info.pid)) return { active: false, ambiguous: false, detail: `${label} stale (pid ${info.pid} not alive)` };
  return { active: true, ambiguous: false, pid: info.pid, detail: `${label} held by pid ${info.pid}` };
}
function computeAuthority() {
  const executorLease = leaseStatus(path.join(dcStateDir(), 'executor.lock'), 'executor lease');
  const breakGlass = leaseStatus(path.join(dcStateDir(), 'break-glass.lock'), 'break-glass marker');
  const initialized = !!(pair && pair.initializedOnce);
  let observedMode;
  if (breakGlass.active && executorLease.active) observedMode = 'ambiguous_conflict';
  else if (breakGlass.active) observedMode = 'break_glass';
  else if (executorLease.active) observedMode = 'managed';
  else observedMode = 'none_active';
  const authoritative = observedMode === 'managed' && !!pair && initialized && !executorLease.ambiguous;
  return {
    configuredExecutionMode: MANAGED ? 'managed' : 'standalone_config',
    observedMode,
    authorityOwner: executorLease.active ? `managed:pid:${executorLease.pid}`
      : breakGlass.active ? `break_glass:pid:${breakGlass.pid}` : 'none',
    executor: { lease: executorLease, breakGlass },
    bridge: { hasUpstreamPair: !!pair, initialized, spawnCount, sessionCount: pair ? pair.sessions.size : 0 },
    enforcement: {
      gatewayAttestationActive: !!GATEWAY_ATTESTATION_KEY,
      capabilityVerificationActive: !!PIPELINE_ACS_PUBLIC_KEY,
      executionTokenConfigured: !!EXECUTION_TOKEN,
      leaseAndFencingEnforced: executorLease.active && !executorLease.ambiguous,
    },
    authoritative,
  };
}

const httpServer = http.createServer(async (req, res) => {
  const path = req.url ? req.url.split('?')[0] : '/';
  if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, pid: process.pid, service: 'desktop-commander-mcp-bridge' })); return; }
  if (path === '/authority') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(computeAuthority())); return; }
  if (path === '/ready') {
    const authority = computeAuthority();
    const ready = !!pair && authority.observedMode !== 'ambiguous_conflict' && !authority.executor.lease.ambiguous && !authority.executor.breakGlass.ambiguous;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready, observedMode: authority.observedMode, hasUpstreamPair: !!pair }));
    return;
  }
  if (path === '/debug/last-headers') {
    const pendingCount = pair ? [...pair.sessions.values()].reduce((count, session) => count + session.pending.size, 0) : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...lastDebug, spawn_count: spawnCount, session_count: pair?.sessions.size || 0, pending_count: pendingCount }));
    return;
  }
  if (path !== '/mcp') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }

  if (EXECUTION_TOKEN && req.method === 'POST') {
    const att = req.headers['x-dc-attestation'];
    if (att && !verifyAttestation(att, req.headers['x-dc-agent'])) { console.error('bridge: invalid gateway attestation; rejecting without forward'); return sendJsonRpcError(res, 400, -32001, 'gateway attestation invalid'); }
  }

  const sid = req.headers['mcp-session-id'];
  let session = sid ? pair.sessions.get(sid) : null;
  if (sid && (!session || session.closed)) return sendJsonRpcError(res, 400, -32001, 'session unknown; reconnect and re-initialize');
  try {
    let body;
    if (req.method === 'POST') body = await readJsonBody(req);
    if (req.method === 'POST') {
      const messages = Array.isArray(body) ? body : [body];
      const initialization = messages.some(isInitialize);
      if (!session && !initialization) return sendJsonRpcError(res, 400, -32000, 'Mcp-Session-Id header is required');
      if (!session) session = createSession(req.headers);
    } else if (!session) return sendJsonRpcError(res, 400, -32001, 'session unknown; reconnect and re-initialize');
    lastDebug.last_headers = req.headers;
    await session.transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('bridge: handleRequest error:', e?.message);
    if (!res.headersSent) {
      const parseFailure = e.status === 400;
      sendJsonRpcError(res, e.status || 500, parseFailure ? -32700 : -32603, parseFailure ? 'Parse error' : 'bridge error');
    } else res.destroy();
  }
});

httpServer.headersTimeout = 30_000;
httpServer.requestTimeout = 0;
httpServer.keepAliveTimeout = 65_000;
httpServer.listen(PORT, '127.0.0.1', () => console.log(`bridge: Streamable HTTP MCP on http://127.0.0.1:${PORT}/mcp (127.0.0.1 only)`));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`bridge: ${signal} received; shutting down cleanly`);
  const activePair = pair;
  const closeListener = new Promise((resolve) => httpServer.close(() => resolve()));
  if (activePair) {
    const transports = [...activePair.sessions.values()].map((session) => session.transport);
    failClosed('gateway shutdown', activePair);
    await Promise.allSettled(transports.map((transport) => transport.close()));
    await activePair.upstream.close().catch((error) => console.error('bridge: upstream close failed:', error?.message));
  }
  await closeListener;
  console.log('bridge: shutdown complete; canonical executor transport closed');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown(signal).then(() => process.exit(0)).catch((error) => {
      console.error('bridge: shutdown failed:', error?.message);
      process.exit(1);
    });
  });
}
