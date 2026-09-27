#!/usr/bin/env node
/**
 * managed.js — ACS managed-mode helpers for desktop-commander-mcp-gateway.
 *
 * Authority model (docs/acs-managed-mode.md, mirrors docs/protocol/
 * acs-dc-v1-capability-contract.md in the ACS repository):
 *
 *  - ACS (the Agent Control Stack gateway) is the SOLE capability issuer.
 *    This gateway never mints, derives, widens, refreshes, or independently
 *    authorizes an acs.dc.v1 capability. It only REQUESTS an already-
 *    authorized capability from ACS and TRANSPORTS it into the MCP request
 *    at params._meta.acsCapability. The ACS private signing key never
 *    reaches this process.
 *  - Forwarded identity (OAuth claims) is ATTRIBUTION, not authority. It is
 *    transported to ACS so the issuer can attribute the request; a spoofed
 *    or missing identity never substitutes for a valid capability.
 *  - Managed mode fails closed. If ACS is unreachable, rejects, or returns
 *    anything but a well-formed capability envelope, the tools/call is not
 *    forwarded to Desktop Commander. There is no standalone fallback on the
 *    managed path: ACS_MANAGED_MODE=1 refuses to start unless the ACS
 *    integration is fully configured, and bridge.js in managed mode never
 *    spawns Desktop Commander with --standalone.
 *
 * Zero runtime dependencies (node:http / node:crypto only), like server.js.
 * Never logs capability contents, signatures, tokens, or tool arguments.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ACS_CAPABILITY_META_KEY = 'capability';
/** Desktop Commander's managed guard transports the same envelope at this key. */
export const ACS_GUARD_META_KEY = 'acsCapability';

/** Jace Commander (acs.jc.v1) — a separate capability version/audience; never interchangeable with acs.dc.v1. */
export const JC_CAPABILITY_VERSION = 'acs.jc.v1';
export const JC_AUDIENCE = 'jace-commander';

export function managedModeFromEnv(env = process.env) {
  const enabled = env.ACS_MANAGED_MODE === '1';
  if (!enabled) return { enabled: false };
  const acsGatewayUrl = (env.ACS_GATEWAY_URL || '').replace(/\/+$/, '');
  const acsGatewayToken = env.ACS_GATEWAY_TOKEN || '';
  if (!acsGatewayUrl || !acsGatewayToken) {
    throw new Error('managed mode requires ACS_GATEWAY_URL and ACS_GATEWAY_TOKEN; refusing to start');
  }
  return { enabled: true, acsGatewayUrl, acsGatewayToken, timeoutMs: parseInt(env.ACS_ISSUANCE_TIMEOUT_MS || '5000', 10) };
}

/**
 * Jace Commander (/jc/mcp) managed config. The jc lane is ALWAYS managed:
 * enabling it without a dedicated ACS jc bridge credential refuses to start.
 * It uses a separate ACS worker identity (acs-jc-bridge) and issue route, so a
 * Desktop Commander bridge credential can never mint jc capabilities and vice
 * versa (ACS enforces the identity per route).
 */
export function jcModeFromEnv(env = process.env) {
  if (env.JC_ENABLED !== '1') return { enabled: false };
  const acsGatewayUrl = (env.ACS_GATEWAY_URL || '').replace(/\/+$/, '');
  const acsGatewayToken = env.ACS_JC_GATEWAY_TOKEN || '';
  if (!acsGatewayUrl || !acsGatewayToken) {
    throw new Error('JC_ENABLED=1 requires ACS_GATEWAY_URL and ACS_JC_GATEWAY_TOKEN; refusing to start');
  }
  if (acsGatewayToken === env.ACS_GATEWAY_TOKEN) {
    throw new Error('ACS_JC_GATEWAY_TOKEN must differ from ACS_GATEWAY_TOKEN (separate ACS bridge identities); refusing to start');
  }
  return {
    enabled: true,
    acsGatewayUrl,
    acsGatewayToken,
    issuePath: '/jc/capability/issue',
    timeoutMs: parseInt(env.ACS_ISSUANCE_TIMEOUT_MS || '5000', 10),
  };
}

export function sortedScopes(raw) {
  const scopes = String(raw || 'fs.read,fs.write,process.exec,process.spawn')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sorted = [...new Set(scopes)].sort();
  if (sorted.length === 0 || JSON.stringify(sorted) !== JSON.stringify(scopes)) {
    throw new Error('runtime scopes must be sorted, unique, and non-empty');
  }
  return sorted;
}

/**
 * The managed Desktop Commander runtime identity, derived from the child's
 * persisted state directory (runtime-identity.json) and a SHA-256 fingerprint
 * of the built entrypoint. Used for the bootstrap request AND its completion,
 * so both sides validate the same identity binding. Returns null when the
 * child state is unavailable — managed mode then fails closed.
 */
export function dcRuntimeIdentityFromState(env = process.env) {
  try {
    const stateDir = env.DESKTOP_COMMANDER_STATE_DIR || path.join(os.homedir(), '.desktop-commander');
    const identity = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime-identity.json'), 'utf8'));
    // The persisted file uses camelCase (runtimeId); accept the snake_case
    // RuntimeIdentityState projection as well.
    const runtimeId = typeof identity.runtimeId === 'string' ? identity.runtimeId : identity.runtime_id;
    if (typeof runtimeId !== 'string' || !runtimeId) return null;
    const entrypoint = env.ACS_DC_ENTRYPOINT || '/home/jacen/projects/desktop-commander/dist/index.js';
    const identityConfigFingerprint = crypto.createHash('sha256').update(fs.readFileSync(entrypoint)).digest('hex');
    return {
      runtimeId,
      identityConfigFingerprint,
      scopes: sortedScopes(env.ACS_DC_RUNTIME_SCOPES),
    };
  } catch {
    return null;
  }
}

/** Fetch an ACS-issued runtime bootstrap challenge for the managed child. */
export async function issueRuntimeBootstrap(managed, identity) {
  const { status, json } = await acsPost(managed, '/dc/runtime/bootstrap', {
    runtimeId: identity.runtimeId,
    identityConfigFingerprint: identity.identityConfigFingerprint,
    scopes: [...identity.scopes],
  });
  if (status !== 201 || !json || typeof json.challenge !== 'string' || json.runtimeId !== identity.runtimeId) {
    throw Object.assign(new Error('ACS runtime bootstrap failed'), { acsCode: 'runtime_bootstrap_failed' });
  }
  return json;
}

/**
 * Complete the challenge on the ACS side. The child has already validated the
 * bootstrap structure during MCP initialize; this marks the runtime attested
 * in ACS's authoritative registry so capability issuance can proceed. The
 * cryptographic execution gate remains the per-call capability signature.
 */
export async function completeRuntimeBootstrap(managed, identity, challenge, runtimeIdentity) {
  // runtimeIdentity is the child's own proof (result._meta.acsRuntimeIdentity from
  // the initialize response), forwarded exactly as produced — never manufactured
  // from the challenge. ACS verifies it against the challenge it issued.
  const { status } = await acsPost(managed, '/dc/runtime/bootstrap/complete', {
    runtimeId: identity.runtimeId,
    identityConfigFingerprint: identity.identityConfigFingerprint,
    scopes: [...identity.scopes],
    challenge: challenge.challenge,
    runtimeIdentity,
  });
  if (status !== 204) {
    throw Object.assign(new Error('ACS runtime bootstrap completion failed'), { acsCode: 'runtime_bootstrap_rejected' });
  }
}

export function injectRuntimeBootstrap(parsed, challenge) {
  const params = parsed && typeof parsed === 'object' ? parsed.params : undefined;
  if (!params) throw Object.assign(new Error('initialize has no params'), { acsCode: 'managed_not_a_tool_call' });
  return {
    ...parsed,
    params: {
      ...params,
      _meta: {
        ...(params._meta || {}),
        acsRuntimeBootstrap: {
          schemaVersion: 1,
          runtimeId: challenge.runtimeId,
          challenge: challenge.challenge,
          scopes: challenge.scopes,
        },
      },
    },
  };
}

/** Post a JSON body to the ACS gateway; resolves {status, json}. Never logs the body. */
export function acsPost(managed, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, managed.acsGatewayUrl);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          authorization: `Bearer ${managed.acsGatewayToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 256 * 1024) { res.destroy(); reject(new Error('acs response too large')); } else chunks.push(c); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(managed.timeoutMs, () => req.destroy(new Error('acs issuance timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Stage 1 — identity transport. Extracts ATTRIBUTION metadata from an already
 * verified OAuth access-token payload. These fields confer no authority; ACS
 * re-checks capability/approval/lease authority independently.
 */
export function identityAttribution(auth) {
  if (!auth || typeof auth !== 'object') return null;
  return {
    subject: typeof auth.sub === 'string' ? auth.sub.slice(0, 128) : null,
    clientId: typeof auth.client_id === 'string' ? auth.client_id.slice(0, 256) : null,
  };
}

/**
 * Stage 2 — capability transport for one tools/call.
 *
 * Returns an async rewriter: given the parsed JSON-RPC request, produces the
 * request body to forward upstream, with params._meta.acsCapability replaced
 * by an ACS-issued envelope. Any failure (ACS unreachable/rejection/malformed
 * envelope, or a client-supplied capability attempt) throws — the caller must
 * fail closed and never forward the request.
 *
 * Stripped first, ALWAYS: any client-supplied _meta.acs* metadata. A spoofed
 * _meta.capability/_meta.acsCapability must never reach Desktop Commander.
 */
export function capabilityTransport(managed, { identity, requestId }) {
  return async function rewriteForAcs(parsed) {
    const params = parsed && typeof parsed === 'object' ? parsed.params : undefined;
    const toolName = params && typeof params.name === 'string' ? params.name : null;
    if (
      !toolName || !params || typeof params !== 'object' ||
      typeof parsed.method !== 'string' || parsed.method !== 'tools/call'
    ) {
      throw Object.assign(new Error('managed mode requires a tools/call'), { acsCode: 'managed_not_a_tool_call' });
    }
    // Anti-spoof: drop every client-supplied ACS authority field.
    const clientMeta = typeof params._meta === 'object' && params._meta !== null ? params._meta : {};
    const spoofed = Object.keys(clientMeta).filter((k) => k === 'capability' || k.startsWith('acs'));
    const cleanParams = { ...params };
    const strippedMeta = Object.fromEntries(
      Object.entries(clientMeta).filter(([k]) => k !== 'capability' && !k.startsWith('acs')),
    );
    if (Object.keys(strippedMeta).length > 0) cleanParams._meta = strippedMeta;
    else delete cleanParams._meta;

    const subject = typeof identity?.subject === 'string' ? identity.subject : '';
    const clientId = typeof identity?.clientId === 'string' ? identity.clientId : '';
    if (!subject || !clientId) {
      throw Object.assign(new Error('managed mode requires authenticated subject and client_id'), { acsCode: 'identity_missing' });
    }
    const actor = subject.startsWith('chatgpt:') ? subject : `chatgpt:${subject}`;
    const issuePath = managed.issuePath || '/dc/capability/issue';
    const actorHeader = issuePath === '/jc/capability/issue' ? 'x-jc-actor' : 'x-dc-actor';
    const { status, json } = await acsPost(managed, issuePath, {
      client_id: clientId,
      tool: toolName,
      argsSummary: JSON.stringify(cleanParams.arguments ?? {}),
      correlationId: requestId,
    }, { [actorHeader]: actor });
    if (status !== 200 || !json || json.decision !== 'allow') {
      const code = json && typeof json.code === 'string'
        ? json.code
        : json && typeof json.reason === 'string'
          ? json.reason
          : json && typeof json.decision === 'string'
            ? json.decision
            : `acs_http_${status || 'unreachable'}`;
      // Preserve the approval challenge metadata ACS attaches to a
      // require_approval response (workItemId/actionHash/approvalInstructions).
      // Transport only: this confers no authority, it just lets the caller
      // find the existing work item to approve through ACS's own endpoint.
      const acsApproval = {};
      if (json && typeof json.workItemId === 'string') acsApproval.workItemId = json.workItemId;
      if (json && typeof json.actionHash === 'string') acsApproval.actionHash = json.actionHash;
      if (json && typeof json.approvalInstructions === 'string') acsApproval.approvalInstructions = json.approvalInstructions;
      if (json && json.approvalSummary && typeof json.approvalSummary === 'object') acsApproval.approvalSummary = json.approvalSummary;
      throw Object.assign(new Error(`ACS did not authorize this invocation (${code})`), { acsCode: code, acsApproval });
    }
    const envelope = json.capability;
    if (
      !envelope || typeof envelope !== 'object' ||
      typeof envelope.signature !== 'string' || envelope.signature.length === 0 ||
      typeof envelope.keyId !== 'string' || envelope.keyId.length === 0 ||
      !envelope.payload || typeof envelope.payload !== 'object' ||
      !envelope.payload.normalizedArguments ||
      typeof envelope.payload.normalizedArguments !== 'object' ||
      Array.isArray(envelope.payload.normalizedArguments)
    ) {
      throw Object.assign(new Error('ACS returned a malformed capability envelope'), { acsCode: 'acs_malformed_capability' });
    }
    // Route binding (fail closed): a capability minted for one executor must
    // never be accepted on the other's route. The jc lane requires a positive
    // acs.jc.v1 / jace-commander match; the dc lane rejects anything carrying
    // jc version/audience markers.
    {
      const payload = envelope.payload || {};
      const jcRoute = (managed.issuePath || '') === '/jc/capability/issue';
      const wrongExecutor = jcRoute
        ? (payload.version !== JC_CAPABILITY_VERSION || payload.audience !== JC_AUDIENCE)
        : (payload.version === JC_CAPABILITY_VERSION || payload.audience === JC_AUDIENCE);
      if (wrongExecutor) {
        throw Object.assign(new Error('ACS returned a capability for a different executor'), { acsCode: 'acs_capability_wrong_audience' });
      }
    }
    return {
      ...parsed,
      params: {
        ...cleanParams,
        // Forward exactly the argument object ACS normalized and signed. The
        // managed guard compares these bytes structurally before execution.
        arguments: envelope.payload.normalizedArguments,
        _meta: {
          ...(cleanParams._meta || {}),
          [ACS_CAPABILITY_META_KEY]: envelope,
          [ACS_GUARD_META_KEY]: envelope,
          // Authoritative lease/result binding derived by ACS (transport only;
          // ACS validates every binding independently at result acceptance).
          acsLeaseBinding: {
            claimActionHash: json.claimActionHash,
            inputHash: json.inputHash,
            workerId: json.workerId,
          },
        },
      },
    };
  };
}

export function isToolsCall(bodyText) {
  try {
    const parsed = JSON.parse(bodyText.toString('utf8'));
    if (Array.isArray(parsed)) {
      // A JSON-RPC batch: the gateway cannot attribute ACS issuance or strip
      // spoofed authority fields per element, so batches carrying tools/call
      // are flagged for fail-closed rejection at the route handler.
      return { isCall: false, parsed, hasBatchedCall: parsed.some((m) => m && m.method === 'tools/call') };
    }
    return { isCall: parsed?.method === 'tools/call', parsed };
  } catch {
    return { isCall: false, parsed: null };
  }
}
