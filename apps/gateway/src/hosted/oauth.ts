import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HostedGatewayConfig } from "./config.js";

export interface HostedIdentity {
  readonly subject: string;
  readonly scopes: string[];
  readonly issuer: string;
}

export type HostedAuthorizationResult =
  | { ok: true; identity: HostedIdentity }
  | { ok: false; statusCode: 401 | 403; error: "invalid_token" | "insufficient_scope"; message: string };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authorizeHostedRequest(
  headers: IncomingHttpHeaders,
  config: HostedGatewayConfig,
  requiredScopes: readonly string[]
): Promise<HostedAuthorizationResult> {
  const token = bearer(headers.authorization);
  if (!token) return { ok: false, statusCode: 401, error: "invalid_token", message: "missing bearer token" };
  try {
    let jwks = jwksCache.get(config.oauthJwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(config.oauthJwksUri));
      jwksCache.set(config.oauthJwksUri, jwks);
    }
    const verified = await jwtVerify(token, jwks, {
      issuer: config.oauthIssuer,
      audience: config.oauthAudience,
      algorithms: ["RS256"]
    });
    const subject = verified.payload.sub?.trim();
    if (!subject) throw new Error("token subject is required");
    const scopes = tokenScopes(verified.payload.scope, verified.payload.scp);
    if (!requiredScopes.every((scope) => scopes.includes(scope))) {
      return { ok: false, statusCode: 403, error: "insufficient_scope", message: "insufficient scope" };
    }
    return { ok: true, identity: { subject, scopes, issuer: config.oauthIssuer } };
  } catch {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid bearer token" };
  }
}

export function hostedWwwAuthenticate(config: HostedGatewayConfig, result?: Exclude<HostedAuthorizationResult, { ok: true }>): string {
  const metadata = `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const parts = [`resource_metadata="${metadata}"`];
  if (result) {
    parts.push(`error="${result.error}"`);
    parts.push(`error_description="${result.message.replaceAll('"', "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim();
}

function tokenScopes(scope: unknown, scp: unknown): string[] {
  const fromScope = typeof scope === "string" ? scope.split(/\s+/u).filter(Boolean) : [];
  const fromScp = Array.isArray(scp) ? scp.filter((entry): entry is string => typeof entry === "string") : [];
  return [...new Set([...fromScope, ...fromScp])];
}
