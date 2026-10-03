import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requesterSchema, WorkerIdentityRegistry } from "@agent-control-stack/work-items";
import { MCP_SCOPES } from "./auth.js";

export const sessionCookiePayloadSchema = z.object({
  v: z.literal(1),
  credentialId: z.string().min(1).optional(),
  actor: z.string().min(1),
  actorId: z.string().min(1).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative()
});
export const gatewayCredentialSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(32),
  actor: z.string().min(1),
  actorId: z.string().min(1),
  roles: z.array(z.enum(["operator", "service", "worker"])).min(1),
  scopes: z.array(z.string().min(1)).min(1),
  /** Optional wall-clock expiry for worker (and other) credentials. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["active", "revoked"]).optional()
});
export type GatewayCredential = z.infer<typeof gatewayCredentialSchema>;
export interface GatewayAuthOptions {
  token: string;
  actor: string;
  /** Registry actor ID this credential is bound to; registry mutations fail closed without it. */
  actorId?: string;
  credentials?: readonly GatewayCredential[];
  /**
   * Mutable worker identity registry with TTL, rotation, and revoke.
   * When present, bearer tokens known to the registry authenticate workers
   * for result submission and reject expired/revoked identities.
   */
  workerIdentities?: WorkerIdentityRegistry;
  /** Internal verifier for opaque device access tokens issued by this gateway. */
  deviceAccessTokenResolver?: (token: string) =>
    | {
        deviceId: string;
        principalId: string;
        scopes: string[];
        expiresAt: string;
      }
    | undefined;
}

/**
 * Credentials that request human approval authority but cannot exercise it.
 *
 * Human-only approval, revocation, execution-mode and grant issuance require a
 * `user` actor holding exactly the operator role. A credential that also carries a
 * service or worker role is refused at request time; operators must see that at
 * boot instead of discovering it as a 403 in production.
 */
export function findIncompatibleHumanApprovalCredentials(
  credentials: readonly GatewayCredential[]
): GatewayCredential[] {
  return credentials.filter(
    (credential) =>
      credential.actor === "user" &&
      credential.roles.includes("operator") &&
      (credential.roles.includes("service") || credential.roles.includes("worker"))
  );
}

export function requireHumanApprovalActor(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  const actor = requireMutationActor(request, reply, auth, "acs:approve");
  if (!actor || !auth) return undefined;
  const credential = gatewayCredentialForRequest(request, auth);
  // Authority comes from configured identity, never caller-supplied actor fields.
  if (
    !credential ||
    credential.actor !== "user" ||
    !credential.roles.includes("operator") ||
    credential.roles.includes("service") ||
    credential.roles.includes("worker")
  ) {
    reply.code(403).send({ error: "human operator authority is required", code: "human_authority_required" });
    return undefined;
  }
  return actor;
}

export function requireMutationActor(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined,
  requiredScope: "acs:write" | "acs:approve" = "acs:write"
): string | undefined {
  if (!auth) {
    reply.code(503).send({ error: "mutation auth is not configured" });
    return undefined;
  }
  const credential = gatewayCredentialForRequest(request, auth);
  if (!credential) {
    reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  if (!credential.roles.includes("operator") && !credential.roles.includes("service")) {
    reply.code(403).send({ error: "operator or service role is required", code: "insufficient_gateway_role" });
    return undefined;
  }
  if (!credential.scopes.includes(requiredScope)) {
    reply.code(403).send({ error: `${requiredScope} scope is required`, code: "insufficient_gateway_scope" });
    return undefined;
  }
  return mutationActorForCredential(credential);
}

export const MIN_ADMIN_MODE_REASON_LENGTH = 8;
export const EXECUTION_MODE_ADMIN_SCOPE = "acs:execution-mode:admin";

/**
 * Enabling admin mode removes human approval from future work. acs:approve only covers
 * approving one bounded action, so admin additionally needs its own scope.
 */
export function requireExecutionModeAdminScope(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): boolean {
  const credential = auth ? gatewayCredentialForRequest(request, auth) : undefined;
  if (credential?.scopes.includes(EXECUTION_MODE_ADMIN_SCOPE)) return true;
  reply.code(403).send({
    error: `${EXECUTION_MODE_ADMIN_SCOPE} scope is required to enable admin mode`,
    code: "insufficient_gateway_scope"
  });
  return false;
}

export function gatewayCredentialCanMutate(credential: GatewayCredential): boolean {
  return (
    (credential.roles.includes("operator") || credential.roles.includes("service")) &&
    credential.scopes.includes("acs:write")
  );
}

export function mutationActorForCredential(credential: GatewayCredential): string {
  return credential.actorId || (credential.id === "legacy" ? credential.actor : credential.id);
}

export function requesterForCredential(credential: GatewayCredential): "user" | "agent" | "system" {
  const requester = requesterSchema.safeParse(credential.actor);
  if (requester.success) return requester.data;
  return credential.roles.includes("service") ? "system" : "user";
}

export function requireWorkerIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  if (!auth) {
    reply.code(503).send({ error: "worker auth is not configured", code: "worker_auth_unconfigured" });
    return undefined;
  }
  const token = bearerToken(request.headers.authorization);
  const now = new Date();

  if (auth.workerIdentities && token) {
    const resolved = auth.workerIdentities.resolve(token, now);
    if (resolved.ok) {
      return resolved.identity.workerId;
    }
    if (resolved.code === "worker_identity_expired") {
      reply.code(410).send({ error: "worker identity has expired", code: resolved.code });
      return undefined;
    }
    if (resolved.code === "worker_identity_revoked") {
      reply.code(401).send({ error: "worker identity has been revoked", code: resolved.code });
      return undefined;
    }
    // Unknown to the registry: fall through to static gateway credentials.
  }

  // Match before the live-credential filter so expiry can return 410 instead of a
  // generic 401, matching lease-expiry semantics for worker authority. Cookie
  // sessions fall through gatewayCredentialForRequest when no bearer is present.
  const matched = token ? matchGatewayCredential(token, auth) : gatewayCredentialForRequest(request, auth);
  if (!matched) {
    reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  if (matched.status === "revoked") {
    reply.code(401).send({ error: "worker identity has been revoked", code: "worker_identity_revoked" });
    return undefined;
  }
  if (matched.expiresAt && Date.parse(matched.expiresAt) <= now.getTime()) {
    reply.code(410).send({ error: "worker identity has expired", code: "worker_identity_expired" });
    return undefined;
  }
  if (!matched.roles.includes("worker") || !matched.scopes.includes("acs:worker") || !matched.actorId) {
    reply.code(403).send({ error: "worker role is required", code: "insufficient_worker_authority" });
    return undefined;
  }
  return matched.actorId;
}

export function hasReadAccess(request: FastifyRequest, auth: GatewayAuthOptions | undefined): boolean {
  if (auth) {
    return Boolean(gatewayCredentialForRequest(request, auth)?.scopes.includes("acs:read"));
  }
  return isDevelopmentLoopbackRequest(request);
}

export function sendReadAccessError(reply: FastifyReply, auth: GatewayAuthOptions | undefined): void {
  if (auth) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  reply.code(503).send({ error: "read auth is not configured for production or exposed access" });
}

export function requireBoundActorId(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  const boundActorId = gatewayCredentialForRequest(request, auth)?.actorId;
  if (!boundActorId) {
    reply.code(503).send({ error: "registry actor binding is not configured; set ACS_GATEWAY_ACTOR_ID" });
    return undefined;
  }
  const claimedActorId = firstHeader(request.headers["x-acs-actor-id"]);
  if (claimedActorId && claimedActorId !== boundActorId) {
    reply.code(403).send({ error: "x-acs-actor-id does not match the credential-bound actor" });
    return undefined;
  }
  return boundActorId;
}

export function gatewayCredentialForRequest(
  request: FastifyRequest,
  auth: GatewayAuthOptions | undefined
): GatewayCredential | undefined {
  if (!auth) return undefined;
  const token = bearerToken(request.headers.authorization);
  const bearerCredential = gatewayCredentialForToken(token, auth);
  if (bearerCredential) return bearerCredential;
  const cookie = cookies(request.headers.cookie)[sessionCookieName];
  return cookie ? gatewayCredentialForSessionCookie(cookie, auth) : undefined;
}

export function matchGatewayCredential(
  token: string | undefined,
  auth: GatewayAuthOptions
): GatewayCredential | undefined {
  if (!token) return undefined;
  const credential = auth.credentials?.find((candidate) => constantTimeEqual(token, candidate.token));
  if (credential) return credential;
  if (auth.token && constantTimeEqual(token, auth.token)) {
    return {
      id: "legacy",
      token: auth.token,
      actor: auth.actor,
      actorId: auth.actorId ?? "",
      roles: auth.actor === "agent" ? ["operator", "worker"] : ["operator"],
      scopes: [
        "acs:read",
        "acs:write",
        "acs:approve",
        "acs:worker",
        // The legacy single token is a human operator only when its actor is "user".
        ...(auth.actor === "user" ? [EXECUTION_MODE_ADMIN_SCOPE] : []),
        ...MCP_SCOPES
      ]
    };
  }
  return undefined;
}

export function gatewayCredentialForToken(
  token: string | undefined,
  auth: GatewayAuthOptions
): GatewayCredential | undefined {
  const credential = matchGatewayCredential(token, auth);
  if (credential) {
    if (!gatewayCredentialIsLive(credential)) return undefined;
    return credential;
  }
  if (!token || !auth.deviceAccessTokenResolver) return undefined;
  const device = auth.deviceAccessTokenResolver(token);
  if (!device || Date.parse(device.expiresAt) <= Date.now()) return undefined;
  const scopes = new Set(device.scopes);
  if (scopes.has("acs:work:read")) scopes.add("acs:read");
  if (scopes.has("acs:work:create")) scopes.add("acs:write");
  return {
    id: `device:${device.deviceId}`,
    token,
    actor: "user",
    actorId: device.principalId,
    roles: ["service"],
    scopes: [...scopes],
    expiresAt: device.expiresAt,
    status: "active"
  };
}

export function gatewayCredentialIsLive(credential: GatewayCredential, nowMs = Date.now()): boolean {
  if (credential.status === "revoked") return false;
  return !credential.expiresAt || Date.parse(credential.expiresAt) > nowMs;
}

export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (Array.isArray(authorization)) return undefined;
  const value = authorization ?? "";
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length).trim();
  return token || undefined;
}

export function sessionCookie(auth: GatewayAuthOptions, secure: boolean, credential: GatewayCredential): string {
  const parts = [
    `${sessionCookieName}=${sessionCookieValue(auth, credential)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${sessionCookieMaxAgeSeconds}`
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function sessionCookieValue(auth: GatewayAuthOptions, credential: GatewayCredential, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      credentialId: credential.id,
      actor: credential.actor,
      ...(credential.actorId ? { actorId: credential.actorId } : {}),
      iat,
      exp: iat + sessionCookieMaxAgeSeconds
    })
  ).toString("base64url");
  return `${payload}.${sessionSignature(credential.token, payload)}`;
}

export function gatewayCredentialForSessionCookie(
  value: string,
  auth: GatewayAuthOptions,
  now = new Date()
): GatewayCredential | undefined {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return undefined;
  }
  try {
    const parsed = sessionCookiePayloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const configuredCredential = parsed.credentialId
      ? auth.credentials?.find((candidate) => candidate.id === parsed.credentialId)
      : undefined;
    const credential =
      configuredCredential ??
      (parsed.credentialId === "legacy" ? gatewayCredentialForToken(auth.token, auth) : undefined);
    if (
      !credential ||
      !gatewayCredentialIsLive(credential, now.getTime()) ||
      !constantTimeEqual(signature, sessionSignature(credential.token, payload))
    ) {
      return undefined;
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return parsed.actor === credential.actor &&
      (parsed.actorId ?? "") === credential.actorId &&
      parsed.iat <= nowSeconds &&
      parsed.exp > nowSeconds
      ? credential
      : undefined;
  } catch {
    return undefined;
  }
}

export function sessionSignature(token: string, payload: string): string {
  return createHmac("sha256", token).update(`acs-session-v2:${payload}`).digest("base64url");
}

export function cookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=");
        return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
      })
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export const sessionCookieName = "acs_session";
export const sessionCookieMaxAgeSeconds = 8 * 60 * 60;

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isDevelopmentLoopbackRequest(request: FastifyRequest): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.HOST && !isLoopbackAddress(process.env.HOST)) {
    return false;
  }
  return (
    isLoopbackAddress(request.socket.remoteAddress ?? request.ip) &&
    isLoopbackHost(request.headers["x-forwarded-host"] ?? request.headers.host)
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "localhost";
}

export function isLoopbackHost(value: string | string[] | undefined): boolean {
  const host = firstHeader(value);
  if (!host) {
    return false;
  }
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}
