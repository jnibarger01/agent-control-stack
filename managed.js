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

export const ACS_CAPABILITY_META_KEY = 'acsCapability';

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

/** Post a JSON body to the ACS gateway; resolves {status, json}. Never logs the body. */
export function acsPost(managed, pathname, body) {
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
    if (!toolName || !params || typeof params !== 'object' || typeof parsed.method !== 'string' || !parsed.method.startsWith('tools/')) {
      throw Object.assign(new Error('managed mode requires a tools/ call'), { acsCode: 'managed_not_a_tool_call' });
    }
    // Anti-spoof: drop every client-supplied ACS metadata field.
    const clientMeta = typeof params._meta === 'object' && params._meta !== null ? params._meta : {};
    const spoofed = Object.keys(clientMeta).filter((k) => k.startsWith('acs'));
    const cleanParams = { ...params };
    const strippedMeta = Object.fromEntries(Object.entries(clientMeta).filter(([k]) => !k.startsWith('acs')));
    if (Object.keys(strippedMeta).length > 0) cleanParams._meta = strippedMeta;
    else delete cleanParams._meta;

    const { status, json } = await acsPost(managed, '/desktop-commander/capability/issue', {
      toolName,
      arguments: cleanParams.arguments ?? {},
      identity,
      requestId,
      // Client-supplied ACS metadata is reported for audit only; it carries no authority.
      strippedMetaKeys: spoofed,
    });
    if (status !== 200 || !json || json.ok !== true) {
      const code = json && typeof json.code === 'string' ? json.code : `acs_http_${status || 'unreachable'}`;
      throw Object.assign(new Error(`ACS did not authorize this invocation (${code})`), { acsCode: code });
    }
    const envelope = json.capability;
    if (
      !envelope || typeof envelope !== 'object' ||
      typeof envelope.signature !== 'string' || envelope.signature.length === 0 ||
      typeof envelope.keyId !== 'string' || envelope.keyId.length === 0 ||
      !envelope.payload || typeof envelope.payload !== 'object'
    ) {
      throw Object.assign(new Error('ACS returned a malformed capability envelope'), { acsCode: 'acs_malformed_capability' });
    }
    return {
      ...parsed,
      params: {
        ...cleanParams,
        _meta: { ...(cleanParams._meta || {}), [ACS_CAPABILITY_META_KEY]: envelope },
      },
    };
  };
}

export function isToolsCall(bodyText) {
  try {
    const parsed = JSON.parse(bodyText.toString('utf8'));
    return { isCall: typeof parsed?.method === 'string' && parsed.method.startsWith('tools/'), parsed };
  } catch {
    return { isCall: false, parsed: null };
  }
}
