import { constants, createPublicKey, timingSafeEqual, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type McpScope = "acs:work:create" | "acs:work:read" | "acs:work:approve" | "acs:worker:claim";

export interface McpOAuthOptions {
  issuer: string;
  resource: string;
  jwksUrl?: string;
  jwks?: JsonWebKeySet;
  audience?: string;
  authorizationServers?: string[];
  resourceName?: string;
}

export interface McpAuthOptions {
  localBearerToken?: string;
  oauth?: McpOAuthOptions;
}

export type McpAuthorizationResult =
  | { ok: true }
  | { ok: false; statusCode: 401 | 403; error: "missing_token" | "invalid_token" | "insufficient_scope"; message: string };

export interface ProtectedResourceMetadata {
  resource: string;
  resource_name: string;
  authorization_servers: string[];
  scopes_supported: McpScope[];
  bearer_methods_supported: ["header"];
}

export interface JsonWebKeySet {
  keys: CryptoJsonWebKey[];
}

const SUPPORTED_SCOPES: McpScope[] = ["acs:work:create", "acs:work:read", "acs:work:approve", "acs:worker:claim"];
const jwksCache = new Map<string, { expiresAt: number; jwks: JsonWebKeySet }>();

export function createProtectedResourceMetadata(oauth: McpOAuthOptions): ProtectedResourceMetadata {
  return {
    resource: oauth.resource,
    resource_name: oauth.resourceName ?? "Agent Control Stack MCP Gateway",
    authorization_servers: oauth.authorizationServers?.length ? oauth.authorizationServers : [oauth.issuer],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"]
  };
}

export function oauthDiscoveryChallenge(
  resourceMetadataUrl: string,
  error?: "invalid_token" | "insufficient_scope",
  errorDescription?: string
): string {
  const params = [`resource_metadata="${quoteAuthParam(resourceMetadataUrl)}"`];
  if (error) {
    params.push(`error="${error}"`);
  }
  if (errorDescription) {
    params.push(`error_description="${quoteAuthParam(errorDescription)}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

export function resolveMcpAuthOptions(input: {
  localBearerToken?: string;
  gatewayBearerToken?: string;
  oauth?: McpOAuthOptions;
  env?: NodeJS.ProcessEnv;
}): McpAuthOptions | undefined {
  const env = input.env ?? process.env;
  const localBearerToken = input.localBearerToken ?? env.ACS_MCP_BEARER_TOKEN ?? input.gatewayBearerToken;
  const oauth = input.oauth ?? resolveMcpOAuthFromEnv(env);
  return localBearerToken || oauth ? { localBearerToken, oauth } : undefined;
}

export async function authorizeMcpRequest(input: {
  headers: IncomingHttpHeaders;
  auth?: McpAuthOptions;
  requiredScopes: McpScope[];
  now?: Date;
}): Promise<McpAuthorizationResult> {
  const token = bearerToken(input.headers.authorization);
  if (!token) {
    return { ok: false, statusCode: 401, error: "missing_token", message: "missing MCP bearer token" };
  }

  if (input.auth?.localBearerToken && constantTimeEqual(token, input.auth.localBearerToken)) {
    return { ok: true };
  }

  if (!input.auth?.oauth) {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid MCP bearer token" };
  }

  try {
    const claims = await verifyJwt(token, input.auth.oauth, input.now ?? new Date());
    if (!hasRequiredScopes(claimScopes(claims), input.requiredScopes)) {
      return { ok: false, statusCode: 403, error: "insufficient_scope", message: "insufficient MCP OAuth scope" };
    }
    return { ok: true };
  } catch {
    return { ok: false, statusCode: 401, error: "invalid_token", message: "invalid MCP OAuth token" };
  }
}

function resolveMcpOAuthFromEnv(env: NodeJS.ProcessEnv): McpOAuthOptions | undefined {
  const issuer = env.ACS_MCP_OAUTH_ISSUER;
  const resource = env.ACS_MCP_OAUTH_RESOURCE;
  const jwksUrl = env.ACS_MCP_OAUTH_JWKS_URL;
  if (!issuer && !resource && !jwksUrl) {
    return undefined;
  }
  if (!issuer || !resource || !jwksUrl) {
    throw new Error("ACS_MCP_OAUTH_ISSUER, ACS_MCP_OAUTH_RESOURCE, and ACS_MCP_OAUTH_JWKS_URL must be set together");
  }
  return {
    issuer,
    resource,
    jwksUrl,
    audience: env.ACS_MCP_OAUTH_AUDIENCE,
    authorizationServers: csv(env.ACS_MCP_OAUTH_AUTHORIZATION_SERVERS) ?? [issuer],
    resourceName: env.ACS_MCP_OAUTH_RESOURCE_NAME
  };
}

function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (Array.isArray(authorization)) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? "");
  return match?.[1];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyJwt(token: string, oauth: McpOAuthOptions, now: Date): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed JWT");
  }

  const header = parseJwtPart(parts[0]) as Record<string, unknown>;
  const claims = parseJwtPart(parts[1]) as Record<string, unknown>;
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (alg !== "RS256" && alg !== "PS256") {
    throw new Error("unsupported JWT alg");
  }
  if (header.typ !== undefined && header.typ !== "JWT" && header.typ !== "at+jwt") {
    throw new Error("unsupported JWT type");
  }

  const jwk = await findSigningKey(oauth, header);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const signature = Buffer.from(parts[2], "base64url");
  const validSignature = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg === "PS256" ? { key, padding: constants.RSA_PKCS1_PSS_PADDING } : key,
    signature
  );
  if (!validSignature) {
    throw new Error("invalid JWT signature");
  }

  const issuer = stringClaim(claims.iss);
  if (issuer !== oauth.issuer) {
    throw new Error("invalid JWT issuer");
  }
  if (!isAudienceValid(claims, oauth)) {
    throw new Error("invalid JWT audience");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const exp = numberClaim(claims.exp);
  if (exp === undefined || exp <= nowSeconds) {
    throw new Error("expired JWT");
  }
  const nbf = numberClaim(claims.nbf);
  if (nbf !== undefined && nbf > nowSeconds) {
    throw new Error("JWT not yet valid");
  }

  return claims;
}

async function findSigningKey(oauth: McpOAuthOptions, header: Record<string, unknown>): Promise<CryptoJsonWebKey> {
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const jwks = oauth.jwks ?? await fetchJwks(oauth);
  const key = jwks.keys.find((candidate) => {
    if (candidate.use && candidate.use !== "sig") return false;
    if (candidate.kty !== "RSA") return false;
    return kid ? candidate.kid === kid : true;
  });
  if (!key) {
    throw new Error("JWT signing key not found");
  }
  return key;
}

async function fetchJwks(oauth: McpOAuthOptions): Promise<JsonWebKeySet> {
  if (!oauth.jwksUrl) {
    throw new Error("JWKS URL is not configured");
  }
  const cached = jwksCache.get(oauth.jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }
  const response = await fetch(oauth.jwksUrl);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${response.status}`);
  }
  const jwks = await response.json() as JsonWebKeySet;
  jwksCache.set(oauth.jwksUrl, { expiresAt: Date.now() + 300_000, jwks });
  return jwks;
}

function parseJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function isAudienceValid(claims: Record<string, unknown>, oauth: McpOAuthOptions): boolean {
  const expected = oauth.audience ?? oauth.resource;
  const audiences = stringListClaim(claims.aud);
  const resources = stringListClaim(claims.resource);
  return audiences.includes(expected) || audiences.includes(oauth.resource) || resources.includes(oauth.resource);
}

function hasRequiredScopes(actual: Set<string>, required: McpScope[]): boolean {
  return required.every((scope) => actual.has(scope));
}

function claimScopes(claims: Record<string, unknown>): Set<string> {
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

function numberClaim(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function csv(input: string | undefined): string[] | undefined {
  const values = input?.split(",").map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

function quoteAuthParam(value: string): string {
  return value.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
