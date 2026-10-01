import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authKeyCacheStats,
  authorizeMcpRequest,
  createTunnelSignaturePayload,
  jwksForOAuth,
  tunnelSessionPublicKey,
  type McpOAuthOptions,
  type McpTunnelOptions
} from "./auth.js";

// This file guards the per-request key-material memoization in auth.ts:
// an inline JWKS must be built once per configured key set, and a tunnel
// session's SPKI PEM must be parsed once per PEM, without changing what the
// authorization decision accepts or rejects.

const oauthIssuer = "https://issuer.test";
const oauthAudience = "acs";

// ------------------------------------------------------------------ helpers

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function ed25519Session() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, pem: String(publicKey.export({ type: "spki", format: "pem" })) };
}

function signedTunnelHeaders(input: {
  privateKey: KeyObject;
  connectorId: string;
  tunnelId: string;
  sessionId: string;
}) {
  const issuedAt = new Date().toISOString();
  const signature = sign(
    null,
    Buffer.from(
      createTunnelSignaturePayload({
        connectorId: input.connectorId,
        tunnelId: input.tunnelId,
        sessionId: input.sessionId,
        issuedAt
      })
    ),
    input.privateKey
  ).toString("base64url");
  return { issuedAt, headers: tunnelHeaders({ ...input, issuedAt, signature }) };
}

function tunnelHeaders(input: {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  issuedAt: string;
  signature: string;
}) {
  return {
    "x-acs-connector-id": input.connectorId,
    "x-acs-tunnel-id": input.tunnelId,
    "x-acs-session-id": input.sessionId,
    "x-acs-issued-at": input.issuedAt,
    "x-acs-signature": `ed25519=${input.signature}`
  };
}

function tunnelAuthOptions(
  publicKeyPem: string,
  expiresAt = new Date(Date.now() + 60_000).toISOString()
): McpTunnelOptions {
  return {
    trustedProxies: ["127.0.0.1"],
    resolveSession: () => ({
      connectorId: "connector-1",
      tunnelId: "tunnel-1",
      sessionId: "session-1",
      publicKeyPem,
      scopes: ["acs:work:read"],
      status: "active" as const,
      connectorStatus: "active" as const,
      expiresAt
    })
  };
}

function rsaJwks() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
  return { privateKey, jwks: { keys: [jwk] } };
}

function rs256Token(privateKey: KeyObject, claims: Record<string, unknown> = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const payload = {
    iss: oauthIssuer,
    sub: "user_123",
    aud: oauthAudience,
    exp: nowSeconds + 300,
    iat: nowSeconds,
    scope: "acs:work:read",
    ...claims
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

// ------------------------------------------------------------- local JWKS

describe("inline JWKS reuse", () => {
  it("builds one key set per configured JWKS object and reuses it", () => {
    const { jwks } = rsaJwks();
    const oauth: McpOAuthOptions = { issuer: oauthIssuer, audience: oauthAudience, jwks };
    const before = authKeyCacheStats().localJwksBuilds;

    const first = jwksForOAuth(oauth);
    const second = jwksForOAuth(oauth);

    expect(second).toBe(first);
    expect(authKeyCacheStats().localJwksBuilds - before).toBe(1);

    // A rotated key set is a new object, so it builds (and is used) separately.
    const rotated: McpOAuthOptions = { ...oauth, jwks: { keys: jwks.keys } };
    expect(jwksForOAuth(rotated)).not.toBe(first);
    expect(authKeyCacheStats().localJwksBuilds - before).toBe(2);
  });

  it("still accepts a token signed by the configured key", async () => {
    const { privateKey, jwks } = rsaJwks();
    const oauth: McpOAuthOptions = { issuer: oauthIssuer, audience: oauthAudience, jwks };

    const first = await authorizeMcpRequest({
      headers: { authorization: `Bearer ${rs256Token(privateKey)}` },
      auth: { oauth },
      requiredScopes: ["acs:work:read"]
    });
    const second = await authorizeMcpRequest({
      headers: { authorization: `Bearer ${rs256Token(privateKey)}` },
      auth: { oauth },
      requiredScopes: ["acs:work:read"]
    });

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, auth: { method: "oauth_jwt", subject: "user_123" } });
  });

  it("still rejects tokens that the configured key set does not vouch for", async () => {
    const { privateKey, jwks } = rsaJwks();
    const attacker = rsaJwks();
    const oauth: McpOAuthOptions = { issuer: oauthIssuer, audience: oauthAudience, jwks };

    const wrongKey = await authorizeMcpRequest({
      headers: { authorization: `Bearer ${rs256Token(attacker.privateKey)}` },
      auth: { oauth },
      requiredScopes: ["acs:work:read"]
    });
    // Warm the configured set, then send a token that is past its expiry.
    await authorizeMcpRequest({
      headers: { authorization: `Bearer ${rs256Token(privateKey)}` },
      auth: { oauth },
      requiredScopes: ["acs:work:read"]
    });
    const expired = await authorizeMcpRequest({
      headers: {
        authorization: `Bearer ${rs256Token(attacker.privateKey, {
          exp: Math.floor(Date.now() / 1000) - 60
        })}`
      },
      auth: { oauth },
      requiredScopes: ["acs:work:read"]
    });

    expect(wrongKey).toMatchObject({ ok: false, error: "invalid_token" });
    expect(expired).toMatchObject({ ok: false, error: "invalid_token" });
  });

  it("keeps throwing when neither a JWKS nor a JWKS URI is configured", () => {
    expect(() => jwksForOAuth({ issuer: oauthIssuer, audience: oauthAudience })).toThrow(/JWKS URI is not configured/);
  });
});

// ------------------------------------------------------- tunnel session keys

describe("tunnel session key reuse", () => {
  it("parses one key object per PEM", () => {
    const session = ed25519Session();
    const before = authKeyCacheStats().tunnelKeyParses;

    const first = tunnelSessionPublicKey(session.pem);
    const second = tunnelSessionPublicKey(session.pem);

    expect(second).toBe(first);
    expect(authKeyCacheStats().tunnelKeyParses - before).toBe(1);
    expect(first.export({ type: "spki", format: "pem" })).toBe(
      createPublicKey(session.pem).export({ type: "spki", format: "pem" })
    );

    const other = tunnelSessionPublicKey(ed25519Session().pem);
    expect(other).not.toBe(first);
    expect(authKeyCacheStats().tunnelKeyParses - before).toBe(2);
  });

  it("never caches a failed parse", () => {
    const before = authKeyCacheStats().tunnelKeyParses;
    expect(() => tunnelSessionPublicKey("not a pem")).toThrow();
    expect(() => tunnelSessionPublicKey("not a pem")).toThrow();
    expect(authKeyCacheStats().tunnelKeyParses).toBe(before);

    // A usable PEM still parses after the failures above.
    expect(tunnelSessionPublicKey(ed25519Session().pem)).toBeInstanceOf(Object);
  });

  it("bounds the cache so a churning registry cannot grow it without limit", () => {
    for (let index = 0; index < 200; index += 1) {
      tunnelSessionPublicKey(ed25519Session().pem);
    }
    expect(authKeyCacheStats().tunnelKeysCached).toBeLessThanOrEqual(128);
    // The bound must not have made the cache useless: the most recent PEM is still reused.
    const session = ed25519Session();
    tunnelSessionPublicKey(session.pem);
    expect(tunnelSessionPublicKey(session.pem)).toBe(tunnelSessionPublicKey(session.pem));
  });

  it("verifies repeated signed requests from the same session without re-parsing", async () => {
    const session = ed25519Session();
    const tunnel = tunnelAuthOptions(session.pem);

    const before = authKeyCacheStats().tunnelKeyParses;
    const first = await authorizeMcpRequest(signedTunnelRequest(session.privateKey, tunnel));
    const second = await authorizeMcpRequest(signedTunnelRequest(session.privateKey, tunnel));

    expect(first).toMatchObject({ ok: true, auth: { method: "tunnel_id", subject: "tunnel:tunnel-1" } });
    expect(second).toMatchObject({ ok: true });
    expect(authKeyCacheStats().tunnelKeyParses - before).toBe(1);
  });

  it("still rejects a tampered signature, a foreign key, and an expired session", async () => {
    const session = ed25519Session();
    const attacker = ed25519Session();
    const tunnel = tunnelAuthOptions(session.pem);

    const valid = signedTunnelRequest(session.privateKey, tunnel);
    const tampered: Parameters<typeof authorizeMcpRequest>[0] = {
      ...valid,
      headers: { ...valid.headers, "x-acs-signature": "ed25519=bad" }
    };
    const foreignKey = signedTunnelRequest(attacker.privateKey, tunnel);
    const expired = await authorizeMcpRequest(
      signedTunnelRequest(
        session.privateKey,
        tunnelAuthOptions(session.pem, new Date(Date.now() - 1_000).toISOString())
      )
    );

    expect(await authorizeMcpRequest(valid)).toMatchObject({ ok: true });
    expect(await authorizeMcpRequest(tampered)).toMatchObject({ ok: false, error: "invalid_token" });
    expect(await authorizeMcpRequest(foreignKey)).toMatchObject({ ok: false, error: "invalid_token" });
    expect(expired).toMatchObject({ ok: false, error: "invalid_token" });
  });
});

function signedTunnelRequest(
  privateKey: KeyObject,
  tunnel: McpTunnelOptions
): Parameters<typeof authorizeMcpRequest>[0] {
  const { headers } = signedTunnelHeaders({
    privateKey,
    connectorId: "connector-1",
    tunnelId: "tunnel-1",
    sessionId: "session-1"
  });
  return {
    headers,
    auth: { tunnel },
    requiredScopes: ["acs:work:read"],
    remoteAddress: "127.0.0.1"
  };
}
