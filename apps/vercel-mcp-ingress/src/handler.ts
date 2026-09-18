import { timingSafeEqual } from "node:crypto";
import {
  MAX_BRIDGE_ENVELOPE_BYTES,
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  bridgeRequestEnvelopeSchema,
  bridgeResultEnvelopeSchema,
  type BridgeEncryptedAuthorization,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";

export type BridgeRoundTrip = (request: BridgeRequestEnvelope, timeoutMs: number) => Promise<BridgeResultEnvelope>;

export class BridgeTimeoutError extends Error {
  constructor(message = "bridge request timed out") {
    super(message);
    this.name = "BridgeTimeoutError";
  }
}

export interface IngressAuthContext {
  requestId: string;
  resultTopic: string;
  expiresAt: string;
}

export type IngressAuthResult =
  { ok: true; auth?: BridgeEncryptedAuthorization } | { ok: false; wwwAuthenticate?: string };

export type IngressAuthorizer = (
  request: Request,
  context: IngressAuthContext
) => Promise<IngressAuthResult> | IngressAuthResult;

export const DEFAULT_MCP_INGRESS_TIMEOUT_MS = 85_000;
export const DEFAULT_EXECUTION_DEADLINE_MARGIN_MS = 5_000;

export interface McpIngressOptions {
  publicToken?: string;
  authorizer?: IngressAuthorizer;
  roundTrip: BridgeRoundTrip;
  requestTimeoutMs?: number;
  executionDeadlineMarginMs?: number;
  idFactory?: () => string;
  now?: () => number;
}

export function createMcpIngressHandler(options: McpIngressOptions) {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_INGRESS_TIMEOUT_MS;
  const executionDeadlineMarginMs =
    options.executionDeadlineMarginMs ??
    Math.min(DEFAULT_EXECUTION_DEADLINE_MARGIN_MS, Math.max(1, Math.floor(timeoutMs / 10)));
  if (executionDeadlineMarginMs < 0 || executionDeadlineMarginMs >= timeoutMs) {
    throw new Error("execution deadline margin must be non-negative and less than request timeout");
  }
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const authorizer =
    options.authorizer ?? (options.publicToken ? createStaticBearerAuthorizer(options.publicToken) : undefined);
  if (!authorizer) {
    throw new Error("MCP ingress authorizer is required");
  }

  return async function handleMcpIngress(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    const requestId = idFactory();
    const resultTopic = `acs-mcp-result-${requestId}`;
    const expiresAt = new Date(now() + timeoutMs - executionDeadlineMarginMs).toISOString();
    const authResult = await authorizer(request, {
      requestId,
      resultTopic,
      expiresAt
    });
    if (authResult.ok === false) {
      const challenge = "wwwAuthenticate" in authResult ? authResult.wwwAuthenticate : undefined;
      return jsonResponse(401, { error: "unauthorized" }, challenge ? { "www-authenticate": challenge } : {});
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse(415, { error: "unsupported_media_type" });
    }

    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BRIDGE_ENVELOPE_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    const envelope = bridgeRequestEnvelopeSchema.safeParse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId,
      resultTopic,
      expiresAt,
      ...(authResult.auth ? { auth: authResult.auth } : {}),
      body
    });
    if (!envelope.success) {
      const oversized = envelope.error.issues.some((issue) => issue.message.includes("exceeds"));
      return jsonResponse(oversized ? 413 : 400, {
        error: oversized ? "request_too_large" : "invalid_bridge_request"
      });
    }

    try {
      const rawResult = await options.roundTrip(envelope.data, timeoutMs);
      const result = bridgeResultEnvelopeSchema.safeParse(rawResult);
      if (!result.success || result.data.requestId !== requestId) {
        return jsonResponse(502, { error: "invalid_bridge_response" });
      }
      return bridgeResultResponse(result.data);
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        return jsonResponse(504, { error: "bridge_timeout" });
      }
      return jsonResponse(502, { error: "bridge_unavailable" });
    }
  };
}
function bridgeResultResponse(result: BridgeResultEnvelope): Response {
  const headers = new Headers({
    "cache-control": "no-store"
  });
  if (result.wwwAuthenticate) {
    headers.set("www-authenticate", result.wwwAuthenticate);
  }
  if (result.body === undefined) {
    return new Response(null, { status: result.statusCode, headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers
  });
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  return new Response(JSON.stringify(body), { status, headers });
}

export function createStaticBearerAuthorizer(expectedToken: string): IngressAuthorizer {
  return (request) => {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match) {
      return {
        ok: false,
        wwwAuthenticate: 'Bearer realm="acs-vercel-mcp"'
      };
    }
    const actual = Buffer.from(match[1], "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? { ok: true }
      : {
          ok: false,
          wwwAuthenticate: 'Bearer realm="acs-vercel-mcp"'
        };
  };
}
