/**
 * TEST-ONLY acs.jc.v1 issuer. Production has no signing code on the DC host:
 * ACS is the sole issuer and keeps the private key (see docs/jace-commander.md).
 */
import crypto from 'node:crypto';
import { strictCanonicalJsonV1 } from '../../dist/managed-acs.js';
import { computeJcInvocationHash, JC_TOOL_POLICIES } from '../../dist/jace-commander/contract.js';

export function makeIssuer(keyId = 'acs-jc-test-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const hex = () => crypto.randomBytes(32).toString('hex');

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
    return { payload, signature, keyId: options.keyId ?? keyId };
  }

  return { keyId, publicKeyB64, privateKey, mint };
}
