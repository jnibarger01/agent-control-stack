import {
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  bridgeResultEnvelopeSchema,
  createBridgeAuthorizationAad,
  openBridgeAuthorization,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { createSignedTunnelHeaders, type AcsTunnelIdentity } from "./tunnel.js";

export interface BridgeReplayPort {
  get(request: BridgeRequestEnvelope): BridgeResultEnvelope | undefined;
  put(request: BridgeRequestEnvelope, result: BridgeResultEnvelope): void;
}

export type LocalAcsCaller = (request: BridgeRequestEnvelope) => Promise<BridgeResultEnvelope>;

export type ResultPublisher = (topic: string, result: BridgeResultEnvelope, idempotencyKey: string) => Promise<void>;

export interface ProcessBridgeRequestDependencies {
  replay: BridgeReplayPort;
  callAcs: LocalAcsCaller;
  publishResult: ResultPublisher;
  now?: () => number;
}

export async function processBridgeRequest(
  request: BridgeRequestEnvelope,
  dependencies: ProcessBridgeRequestDependencies
): Promise<void> {
  const replayed = dependencies.replay.get(request);
  if (replayed) {
    await dependencies.publishResult(request.resultTopic, replayed, request.requestId);
    return;
  }

  const now = dependencies.now ?? Date.now;
  if (Date.parse(request.expiresAt) <= now()) {
    const expired = bridgeResultEnvelopeSchema.parse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      statusCode: 504,
      body: { error: "bridge_request_expired" }
    });
    dependencies.replay.put(request, expired);
    await dependencies.publishResult(request.resultTopic, expired, request.requestId);
    return;
  }

  const result = await dependencies.callAcs(request);
  const parsed = bridgeResultEnvelopeSchema.parse(result);
  if (parsed.requestId !== request.requestId) {
    throw new Error("local ACS result correlation mismatch");
  }
  dependencies.replay.put(request, parsed);
  await dependencies.publishResult(request.resultTopic, parsed, request.requestId);
}
interface LocalAcsCallerBaseOptions {
  url: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  maxCallDurationMs?: number;
}

export type LocalAcsCallerOptions =
  | (LocalAcsCallerBaseOptions &
      AcsTunnelIdentity & {
        privateKeyPem: string;
        authorizationResolver?: never;
      })
  | (LocalAcsCallerBaseOptions & {
      authorizationResolver: (request: BridgeRequestEnvelope) => string;
      connectorId?: never;
      tunnelId?: never;
      sessionId?: never;
      privateKeyPem?: never;
    });

export function createLocalAcsCaller(options: LocalAcsCallerOptions): LocalAcsCaller {
  const url = validateLoopbackMcpUrl(options.url);
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxCallDurationMs = options.maxCallDurationMs ?? 75_000;
  if (!Number.isInteger(maxCallDurationMs) || maxCallDurationMs <= 0) {
    throw new Error("local ACS max call duration must be a positive integer");
  }

  return async (request: BridgeRequestEnvelope) => {
    const remainingMs = Date.parse(request.expiresAt) - now().getTime();
    if (remainingMs <= 0) {
      throw new Error("bridge request expired before local ACS call");
    }
    const callTimeoutMs = Math.max(1, Math.min(maxCallDurationMs, remainingMs));
    const authHeaders =
      typeof options.authorizationResolver === "function"
        ? { authorization: options.authorizationResolver(request) }
        : createSignedTunnelHeaders({
            connectorId: options.connectorId,
            tunnelId: options.tunnelId,
            sessionId: options.sessionId,
            privateKeyPem: options.privateKeyPem,
            issuedAt: now().toISOString()
          });

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(callTimeoutMs)
    });

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("local ACS returned invalid JSON");
      }
    }

    return bridgeResultEnvelopeSchema.parse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      statusCode: response.status,
      ...(body === undefined ? {} : { body }),
      ...(response.headers.get("www-authenticate")
        ? {
            wwwAuthenticate: response.headers.get("www-authenticate") ?? undefined
          }
        : {})
    });
  };
}
function validateLoopbackMcpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("local ACS URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("local ACS URL must not embed credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new Error("local ACS URL must be loopback-only");
  }
  return url;
}

export function createEncryptedAuthorizationResolver(
  privateKeyPem: string
): (request: BridgeRequestEnvelope) => string {
  return (request) => {
    if (!request.auth) {
      throw new Error("encrypted bridge authorization is required");
    }
    const aad = createBridgeAuthorizationAad({
      requestId: request.requestId,
      resultTopic: request.resultTopic,
      expiresAt: request.expiresAt
    });
    return openBridgeAuthorization(request.auth, privateKeyPem, aad);
  };
}
