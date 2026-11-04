/**
 * TEST-ONLY acs.jc.v1 issuer. Production has no signing code on the DC host:
 * ACS is the sole issuer and keeps the private key (see docs/jace-commander.md).
 */
import crypto from 'node:crypto';
import { strictCanonicalJsonV1 } from '../../dist/canonical-json.js';
import { computeJcInvocationHash, JC_TOOL_POLICIES } from '../../dist/contract.js';

export function makeIssuer(keyId = 'acs-jc-test-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const hex = () => crypto.randomBytes(32).toString('hex');

  let lastPayload;
  function mint(toolName, normalizedArguments, overrides = {}, options = {}) {
    const now = options.now ?? Date.now();
    const policy = JC_TOOL_POLICIES[toolName];
    const payload = {
      version: 'acs.jc.v1',
      issuer: 'acs',
      audience: 'jace-commander',
      runtimeId: 'jc-test-runtime',
      workItemId: 'wi-123',
      attemptId: 'att-1',
      leaseId: 'lease-1',
      leaseEpoch: 1,
      toolName,
      normalizedArguments,
      invocationHash: computeJcInvocationHash(toolName, normalizedArguments),
      actionHash: hex(),
      requestHash: hex(),
      planHash: hex(),
      scopes: policy ? [...policy.scopes] : ['integration.read'],
      ...(policy?.requiresApproval ? { approvalId: 'appr-human-1' } : {}),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 20_000).toISOString(),
      nonce: crypto.randomBytes(32).toString('base64url'),
      ...overrides,
    };
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete payload[key];
    const signingKey = options.privateKey ?? privateKey;
    const signature = crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload), 'utf8'), signingKey).toString('base64url');
    lastPayload = payload;
    return { payload, signature, keyId: options.keyId ?? keyId };
  }

  return { keyId, publicKeyB64, privateKey, mint, get lastPayload() { return lastPayload; } };
}

export function authorityBody(issuer) {
  const p = issuer.lastPayload;
  return {
    workItem: {id:p.workItemId,status:'running',requesterSubject:'chatgpt:alice',
      requestedActions:[{params:{contract:'acs.jc.v1',tool:p.toolName,invocationHash:p.invocationHash}}]},
    attemptLeases:[{leaseId:p.leaseId,attemptId:p.attemptId,workItemId:p.workItemId,
      workerId:'acs-jc-bridge',fencingEpoch:p.leaseEpoch,planHash:p.planHash,approvalId:p.approvalId,
      status:'active',expiresAt:new Date(Date.now()+60000).toISOString()}]
  };
}
export function authorityFetch(issuer) {
  return async () => new Response(JSON.stringify(authorityBody(issuer)), {status:200,headers:{'content-type':'application/json'}});
}
