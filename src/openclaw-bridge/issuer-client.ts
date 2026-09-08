import crypto from 'node:crypto';
import { z } from 'zod';
import { computeDesktopCommanderInvocationHash, strictCanonicalJsonV1 } from '../managed-acs.js';
import type { OpenClawBridgeConfig } from './config.js';

/**
 * Client for the narrow, documented issuer contract described in the README.
 * The bridge sends only what the issuer needs to make and sign an approval
 * decision (runtime identity, tool name, normalized arguments, a bridge
 * request id, and the invocation hash the child will independently
 * recompute). The issuer alone decides approval and holds the ACS signing
 * key; this client never signs anything and never fabricates a capability.
 */

export type IssuerClientErrorCode =
  | 'ISSUER_TIMEOUT'
  | 'ISSUER_UNREACHABLE'
  | 'ISSUER_DENIED'
  | 'ISSUER_MALFORMED_RESPONSE'
  | 'ISSUER_CAPABILITY_MISMATCH';

export class IssuerClientError extends Error {
  constructor(public readonly code: IssuerClientErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'IssuerClientError';
  }
}

// Loose but structurally sound: this is a fast-fail sanity check, not the
// authoritative gate. The managed child's ManagedAcsGuard independently
// re-verifies the signature, every field, and single-use nonce before it
// ever executes the tool — the bridge holds no verification key and cannot
// substitute for that check.
const CapabilityPayloadSchema = z.object({
  version: z.literal('acs.dc.v1'),
  issuer: z.literal('acs'),
  audience: z.literal('desktop-commander'),
  runtimeId: z.string().min(1),
  workItemId: z.string().min(1),
  attemptId: z.string().min(1),
  leaseId: z.string().min(1),
  leaseEpoch: z.number().int().nonnegative(),
  toolName: z.string().min(1),
  normalizedArguments: z.record(z.unknown()),
  invocationHash: z.string().regex(/^[a-f0-9]{64}$/),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.string()).min(1),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  nonce: z.string().min(1),
  approvalId: z.string().min(1).optional(),
}).strict();

const CapabilityEnvelopeSchema = z.object({
  keyId: z.string().min(1).max(64),
  signature: z.string().min(1),
  payload: CapabilityPayloadSchema,
}).strict();

const IssuerSuccessResponseSchema = z.object({
  capability: CapabilityEnvelopeSchema,
}).strict();

export type IssuedCapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;

export interface CapabilityRequestInput {
  runtimeId: string;
  toolName: string;
  normalizedArguments: Record<string, unknown>;
}

/**
 * Requests a single-use signed `acs.dc.v1` capability for one managed tool
 * call. Fails closed (throws IssuerClientError) on any network failure,
 * non-2xx response, malformed body, or a response that does not match the
 * exact invocation it was asked to authorize — it never returns a
 * best-effort or partially-validated capability.
 */
export async function requestManagedCapability(
  config: OpenClawBridgeConfig,
  input: CapabilityRequestInput,
): Promise<IssuedCapabilityEnvelope> {
  const invocationHash = computeDesktopCommanderInvocationHash(input.toolName, input.normalizedArguments);
  const requestBody = {
    version: 'acs.dc.v1' as const,
    requestId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    runtimeId: input.runtimeId,
    toolName: input.toolName,
    normalizedArguments: input.normalizedArguments,
    invocationHash,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.issuerTimeoutMs);
  let response: Response;
  try {
    response = await fetch(config.issuerUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(config.issuerToken ? { authorization: `Bearer ${config.issuerToken}` } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    // Never include the raw error object's message when it might echo
    // request internals containing the bearer token; AbortError from our own
    // timeout is the only case we distinguish, and network causes are
    // reported generically.
    throw new IssuerClientError(
      controller.signal.aborted ? 'ISSUER_TIMEOUT' : 'ISSUER_UNREACHABLE',
      controller.signal.aborted
        ? `Desktop Commander ACS capability issuer request timed out after ${config.issuerTimeoutMs}ms`
        : 'Desktop Commander ACS capability issuer is unreachable',
      error,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new IssuerClientError(
      'ISSUER_DENIED',
      `Desktop Commander ACS capability issuer declined the request (HTTP ${response.status})`,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new IssuerClientError(
      'ISSUER_MALFORMED_RESPONSE',
      'Desktop Commander ACS capability issuer returned a non-JSON response',
      error,
    );
  }

  const parsed = IssuerSuccessResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IssuerClientError(
      'ISSUER_MALFORMED_RESPONSE',
      'Desktop Commander ACS capability issuer response failed schema validation',
      parsed.error,
    );
  }

  const { payload } = parsed.data.capability;
  const matchesRequest = payload.runtimeId === input.runtimeId
    && payload.toolName === input.toolName
    && payload.invocationHash === invocationHash
    && exactStructuralEqual(payload.normalizedArguments, input.normalizedArguments);
  if (!matchesRequest) {
    throw new IssuerClientError(
      'ISSUER_CAPABILITY_MISMATCH',
      'Desktop Commander ACS capability issuer response does not match the requested tool invocation',
    );
  }

  return parsed.data.capability;
}

function exactStructuralEqual(left: unknown, right: unknown): boolean {
  try {
    return strictCanonicalJsonV1(left) === strictCanonicalJsonV1(right);
  } catch {
    return false;
  }
}
