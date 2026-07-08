import { createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload
} from "jose";

export const MCP_SCOPES = ["acs:work:create", "acs:work:read", "acs:work:approve", "acs:worker:claim"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export type McpAuthMethod = "local_bearer" | "oauth_jwt" | "tunnel_id";

export interface McpAuthenticatedRequest {
  method: McpAuthMethod;
  subject: string;
  issuer: string;
  connectorId?: string;
  tunnelId?: string;
  sessionId?: string;
  issuedAt?: string;
  scopes: string[];
}

export interface McpOAuthOptions {
  issuer: string;
  audience: string;
  resource?: string;
  jwksUri?: string;
  jwks?: JSONWebKeySet;
  authorizationServers?: string[];
  resourceName?: string;
}

export interface McpTunnelConnectorOptions {
  id: string;
  tunnelId: string;
  scopes: McpScope[];
}

export interface McpTunnelSessionLookup {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
}

export interface McpTunnelSessionRecord extends McpTunnelSessionLookup {
  publicKeyPem: string;
  scopes: string[];
  status: "active" | "revoked";
  connectorStatus: "active" | "revoked";
  expiresAt: string;
}

export interface McpTunnelOptions {
  trustedProxies: string[];
  connectors?: McpTunnelConnectorOptions[];
  resolveSession?: (lookup: McpTunnelSessionLookup) => McpTunnelSessionRecord | undefined | Promise<McpTunnelSessionRecord | undefined>;
  maxIssuedAgeMs?: number;
}

export interface McpAuthOptions {
  localBearerToken?: string;
  oauth?: McpOAuthOptions;
  tunnel?: McpTunnelOptions;
}

export type McpAuthorizationResult =
  | { ok: true; auth: McpAuthenticatedRequest }
  | { ok: false; statusCode: 401 | 403; error: "missing_token" | "invalid_token" | "insufficient_scope"; message: string };

export interface ProtectedResourceMetadata {
  resource: string;
  resource_name: string;
  authorization_servers: string[];
  scopes_supported: McpScope[];
  bearer_methods_supported: ["header"];
}

const DEFAULT_TUNNEL_SCOPES: McpScope[] = ["acs:work:create", "acs:work:read"];
const DEFAULT_TUNNEL_MAX_ISSUED_AGE_MS = 60_000;
const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function createProtectedResourceMetadata(oauth: McpOAuthOptions): ProtectedResourceMetadata {
  return {
    resource: oauthResource(oauth),
    resource_name: oauth.resourceName ?? "Agent Control Stack MCP Gateway",
    authorization_servers: oauth.authorizationServers?.length ? oauth.authorizationServers : [oauth.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"]
  };
}

export function oauthDiscoveryChallenge(
  resourceMetadataUrl: string,
  error?: "invalid_token" | "insufficient_scope",
  errorDescription?: string,
  scopes?: McpScope[]
): string {
  const params = [`resource_metadata="${quoteAuthParam(resourceMetadataUrl)}"`];
  if (error) {
    params.push(`error="${error}"`);
  }
  if (errorDescription) {
    params.push(`error_description="${quoteAuthParam(errorDescription)}"`);
  }
  if (scopes?.length) {
    params.push(`scope="${quoteAuthParam(scopes.join(" "))}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

export function resolveMcpAuthOptions(input: {
  localBearerToken?: string;
  oauth?: McpOAuthOptions;
  tunnel?: McpTunnelOptions;
  env?: NodeJS.ProcessEnv;
}): McpAuthOptions | undefined {
  const env = input.env ?? process.env;
  const localBearerToken = env.NODE_ENV === "production" ? undefined : input.localBearerToken ?? env.ACS_MCP_BEARER_TOKEN;
  const oauth = input.oauth ?? resolveMcpOAuthFromEnv(env);
  const tunnel = input.tunnel ?? resolveMcpTunnelFromEnv(env);
  return localBearerToken || oauth || tunnel ? { localBearerToken, oauth, tunnel } : undefined;
}

export async function authorizeMcpRequest(input: {
  headers: IncomingHttpHeaders;
  auth?: McpAuthOptions;
  requiredScopes: McpScope[];
  remoteAddress?: string;
  now?: Date;
}): Promise<McpAuthorizationResult> {
  const tunnel = await authorizeTunnelRequest(input.headers, input.auth?.tunnel, input.remoteAddress, input.requiredScopes, input.now ?? new Date());
  if (tunnel) {
    return tunnel;
  }

  const token = bearerToken(input.headers.authorization);
  if (!token) {
    return { ok: false, statusCode: 401, error: "missing_token", message: "missing bearer token" };
  }

  if (input.auth?.localBearerToken && constantTimeEqual(token, input.auth.localBearerToken)) {
    return {
      ok: true,
      auth: {
        method: "local_bearer",
        subject: "local-dev",
        issuer: "local",
        scopes: [...MCP_SCOPES]
      }
    };
  }

  if (!input.auth?.oauth) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid bearer token" };
  }

  try {
    const auth = await verifyJwt(token, input.auth.oauth, input.now ?? new Date());
    if (!hasRequiredScopes(new Set(auth.scopes), input.requiredScopes)) {
      return { ok: false, statusCode: 403, error: "insufficient_scope", message: "insufficient scope" };
    }
    return { ok: true, auth };
  } catch {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid bearer token" };
  }
}

function resolveMcpOAuthFromEnv(env: NodeJS.ProcessEnv): McpOAuthOptions | undefined {
  const issuer = env.ACS_OAUTH_ISSUER;
  const audience = env.ACS_OAUTH_AUDIENCE;
  const jwksUri = env.ACS_OAUTH_JWKS_URI;
  if (!issuer && !audience && !jwksUri) {
    return undefined;
  }
  if (!issuer || !audience || !jwksUri) {
    throw new Error("ACS_OAUTH_ISSUER, ACS_OAUTH_AUDIENCE, and ACS_OAUTH_JWKS_URI must be set together");
  }
  return {
    issuer,
    audience,
    resource: audience,
    jwksUri,
    authorizationServers: [issuer]
  };
}

function resolveMcpTunnelFromEnv(env: NodeJS.ProcessEnv): McpTunnelOptions | undefined {
  if (env.ACS_AUTH_MODE !== "tunnel_id") {
    return undefined;
  }
  const trustedProxies = csv(env.ACS_TRUSTED_TUNNEL_PROXY);
  const connectorEntries = csv(env.ACS_ALLOWED_TUNNEL_IDS);
  if (!trustedProxies) {
    throw new Error("ACS_TRUSTED_TUNNEL_PROXY must be set when ACS_AUTH_MODE=tunnel_id");
  }
  const allowUnsignedTunnelId = env.NODE_ENV !== "production" && env.ACS_ALLOW_UNSIGNED_TUNNEL_ID_DEV === "1";
  const scopes = parseMcpScopes(env.ACS_TUNNEL_SCOPES) ?? DEFAULT_TUNNEL_SCOPES;
  return {
    trustedProxies,
    connectors: allowUnsignedTunnelId ? connectorEntries?.map((entry) => tunnelConnector(entry, scopes)) ?? [] : []
  };
}

async function authorizeTunnelRequest(
  headers: IncomingHttpHeaders,
  tunnel: McpTunnelOptions | undefined,
  remoteAddress: string | undefined,
  requiredScopes: McpScope[],
  now: Date
): Promise<McpAuthorizationResult | undefined> {
  if (!tunnel) {
    return undefined;
  }
  const tunnelId = singleHeader(headers["x-acs-tunnel-id"]);
  const connectorId = singleHeader(headers["x-acs-connector-id"]);
  const sessionId = singleHeader(headers["x-acs-session-id"]);
  const issuedAt = singleHeader(headers["x-acs-issued-at"]);
  const signature = singleHeader(headers["x-acs-signature"]);
  if (!tunnelId && !connectorId && !sessionId) {
    return undefined;
  }
  if (!isTrustedTunnelProxy(remoteAddress, tunnel.trustedProxies)) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "untrusted tunnel proxy" };
  }
  if (tunnel.resolveSession || sessionId || issuedAt || signature) {
    return authorizeSignedTunnelRequest({
      tunnel,
      connectorId,
      tunnelId,
      sessionId,
      issuedAt,
      signature,
      requiredScopes,
      now
    });
  }
  if (!tunnelId) {
    return { ok: false, statusCode: 401, error: "missing_token", message: "missing tunnel identity" };
  }
  const connector = tunnel.connectors?.find((candidate) => candidate.tunnelId === tunnelId);
  if (!connector || (connectorId && connectorId !== connector.id)) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "unknown tunnel identity" };
  }
  if (!hasRequiredScopes(new Set(connector.scopes), requiredScopes)) {
    return { ok: false, statusCode: 403, error: "insufficient_scope", message: "insufficient scope" };
  }
  return {
    ok: true,
    auth: {
      method: "tunnel_id",
      subject: `tunnel:${connector.tunnelId}`,
      issuer: "trusted_tunnel_proxy",
      connectorId: connector.id,
      tunnelId: connector.tunnelId,
      scopes: [...connector.scopes]
    }
  };
}

async function authorizeSignedTunnelRequest(input: {
  tunnel: McpTunnelOptions;
  connectorId?: string;
  tunnelId?: string;
  sessionId?: string;
  issuedAt?: string;
  signature?: string;
  requiredScopes: McpScope[];
  now: Date;
}): Promise<McpAuthorizationResult> {
  if (!input.connectorId || !input.tunnelId || !input.sessionId) {
    return { ok: false, statusCode: 401, error: "missing_token", message: "missing tunnel session identity" };
  }
  if (!input.issuedAt || !input.signature) {
    return { ok: false, statusCode: 401, error: "missing_token", message: "missing tunnel session signature" };
  }
  const session = await input.tunnel.resolveSession?.({
    connectorId: input.connectorId,
    tunnelId: input.tunnelId,
    sessionId: input.sessionId
  });
  if (!session) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "unknown tunnel session" };
  }
  if (session.connectorStatus !== "active" || session.status !== "active") {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "revoked tunnel session" };
  }
  if (Date.parse(session.expiresAt) <= input.now.getTime()) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "expired tunnel session" };
  }
  if (!isFreshIssuedAt(input.issuedAt, input.now, input.tunnel.maxIssuedAgeMs ?? DEFAULT_TUNNEL_MAX_ISSUED_AGE_MS)) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "stale tunnel assertion" };
  }
  if (!verifyTunnelSignature(session.publicKeyPem, input.signature, {
    connectorId: input.connectorId,
    tunnelId: input.tunnelId,
    sessionId: input.sessionId,
    issuedAt: input.issuedAt
  })) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid tunnel signature" };
  }
  const scopes = parseMcpScopeList(session.scopes);
  if (!scopes || !hasRequiredScopes(new Set(scopes), input.requiredScopes)) {
    return { ok: false, statusCode: 403, error: "insufficient_scope", message: "insufficient scope" };
  }
  return {
    ok: true,
    auth: {
      method: "tunnel_id",
      subject: `tunnel:${input.tunnelId}`,
      issuer: "trusted_tunnel_proxy",
      connectorId: input.connectorId,
      tunnelId: input.tunnelId,
      sessionId: input.sessionId,
      issuedAt: input.issuedAt,
      scopes
    }
  };
}

export function createTunnelSignaturePayload(input: {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  issuedAt: string;
}): string {
  return `acs-tunnel-v1\n${input.connectorId}\n${input.tunnelId}\n${input.sessionId}\n${input.issuedAt}`;
}

function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (Array.isArray(authorization)) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? "");
  return match?.[1];
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function isTrustedTunnelProxy(remoteAddress: string | undefined, trustedProxies: string[]): boolean {
  const remote = normalizeAddress(remoteAddress);
  return remote !== undefined && trustedProxies.some((proxy) => normalizeAddress(proxy) === remote);
}

function normalizeAddress(address: string | undefined): string | undefined {
  return address?.startsWith("::ffff:") ? address.slice(7) : address;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyJwt(token: string, oauth: McpOAuthOptions, now: Date): Promise<McpAuthenticatedRequest> {
  const { payload, protectedHeader } = await jwtVerify(token, jwks(oauth), {
    issuer: oauth.issuer,
    algorithms: ["RS256", "PS256"],
    currentDate: now
  });

  if (protectedHeader.typ !== undefined && protectedHeader.typ !== "JWT" && protectedHeader.typ !== "at+jwt") {
    throw new Error("unsupported JWT type");
  }
  if (payload.exp === undefined) {
    throw new Error("missing JWT expiration");
  }
  if (!isAudienceValid(payload, oauth)) {
    throw new Error("invalid JWT audience");
  }

  const subject = stringClaim(payload.sub) ?? stringClaim(payload.client_id);
  if (!subject) {
    throw new Error("missing JWT subject");
  }

  return {
    method: "oauth_jwt",
    subject,
    issuer: oauth.issuer,
    scopes: [...claimScopes(payload)]
  };
}

function jwks(oauth: McpOAuthOptions): ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet> {
  if (oauth.jwks) {
    return createLocalJWKSet(oauth.jwks);
  }
  if (!oauth.jwksUri) {
    throw new Error("JWKS URI is not configured");
  }
  let cached = remoteJwksCache.get(oauth.jwksUri);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(oauth.jwksUri));
    remoteJwksCache.set(oauth.jwksUri, cached);
  }
  return cached;
}

function isAudienceValid(claims: JWTPayload, oauth: McpOAuthOptions): boolean {
  const expected = oauth.audience;
  const resource = oauthResource(oauth);
  const audiences = stringListClaim(claims.aud);
  const resources = stringListClaim(claims.resource);
  return audiences.includes(expected) || audiences.includes(resource) || resources.includes(resource);
}

function hasRequiredScopes(actual: Set<string>, required: McpScope[]): boolean {
  return required.every((scope) => actual.has(scope));
}

function claimScopes(claims: JWTPayload): Set<string> {
  return new Set([
    ...scopeList(claims.scope),
    ...scopeList(claims.scp)
  ]);
}

function scopeList(input: unknown): string[] {
  if (typeof input === "string") {
    return input.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  return [];
}

function stringListClaim(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.filter((value): value is string => typeof value === "string");
  return [];
}

function stringClaim(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined;
}

function parseMcpScopes(input: string | undefined): McpScope[] | undefined {
  const values = input?.split(/[,\s]+/).filter(Boolean);
  return values ? parseMcpScopeList(values, true) : undefined;
}

function parseMcpScopeList(values: string[], throwOnInvalid = false): McpScope[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  for (const value of values) {
    if (!MCP_SCOPES.includes(value as McpScope)) {
      if (throwOnInvalid) {
        throw new Error(`unsupported MCP tunnel scope: ${value}`);
      }
      return undefined;
    }
  }
  return values as McpScope[];
}

function isFreshIssuedAt(issuedAt: string, now: Date, maxIssuedAgeMs: number): boolean {
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return false;
  }
  return Math.abs(now.getTime() - issuedAtMs) <= maxIssuedAgeMs;
}

function verifyTunnelSignature(
  publicKeyPem: string,
  signature: string,
  payload: Parameters<typeof createTunnelSignaturePayload>[0]
): boolean {
  try {
    const normalized = signature.startsWith("ed25519=") ? signature.slice("ed25519=".length) : signature;
    return verifySignature(
      null,
      Buffer.from(createTunnelSignaturePayload(payload)),
      createPublicKey(publicKeyPem),
      Buffer.from(normalized, "base64url")
    );
  } catch {
    return false;
  }
}

function tunnelConnector(entry: string, scopes: McpScope[]): McpTunnelConnectorOptions {
  const [id, tunnelId] = entry.includes("=") ? entry.split("=", 2) : [entry, entry];
  if (!id || !tunnelId) {
    throw new Error("ACS_ALLOWED_TUNNEL_IDS entries must be tunnel_id or connector_id=tunnel_id");
  }
  return { id, tunnelId, scopes };
}

function csv(input: string | undefined): string[] | undefined {
  const values = input?.split(",").map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

function quoteAuthParam(value: string): string {
  return value.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function oauthResource(oauth: McpOAuthOptions): string {
  return oauth.resource ?? oauth.audience;
}
