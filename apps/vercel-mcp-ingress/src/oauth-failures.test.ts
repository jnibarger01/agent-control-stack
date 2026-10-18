import { generateKeyPairSync } from "node:crypto";
import { errors } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createMcpIngressHandler } from "./handler.js";
import { createOauthBearerAuthorizer } from "./oauth.js";

const METADATA = "https://acs.example/.well-known/oauth-protected-resource/mcp";
const context = { requestId: "req_f", resultTopic: "acs-mcp-result-req_f", expiresAt: "2026-10-17T18:00:00.000Z" };
const publicKeyPem = String(generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }));

function authorizerFailingWith(error: unknown) {
  return createOauthBearerAuthorizer({
    issuer: "https://issuer.example",
    audience: "https://acs.example/mcp",
    jwksUri: "https://issuer.example/jwks",
    resourceMetadataUrl: METADATA,
    bridgePublicKeyPem: publicKeyPem,
    verifyToken: vi.fn(async () => {
      throw error;
    })
  });
}
const withToken = () =>
  new Request("https://acs.example/mcp", { method: "POST", headers: { authorization: "Bearer t" } });

describe("ingress separates 'sign in again' from 'try again later'", () => {
  it("an expired token is a 401 invalid_token that names expiry, so clients refresh or reconnect", async () => {
    const result = await authorizerFailingWith(
      new errors.JWTExpired('"exp" claim timestamp check failed', {}, "exp", "check_failed")
    )(withToken(), context);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect((result as { wwwAuthenticate: string }).wwwAuthenticate).toContain(`resource_metadata="${METADATA}"`);
    expect((result as { wwwAuthenticate: string }).wwwAuthenticate).toContain('error="invalid_token"');
    expect((result as { wwwAuthenticate: string }).wwwAuthenticate).toMatch(/error_description="[^"]*expired/i);
  });

  it.each([
    ["bad signature", new errors.JWSSignatureVerificationFailed()],
    ["wrong audience", new errors.JWTClaimValidationFailed("unexpected aud", {}, "aud", "check_failed")],
    ["malformed token", new errors.JWTInvalid("bad")]
  ])("%s is a 401 invalid_token", async (_name, error) => {
    const result = await authorizerFailingWith(error)(withToken(), context);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect((result as { wwwAuthenticate: string }).wwwAuthenticate).toContain('error="invalid_token"');
  });

  it.each([
    ["JWKS fetch timeout", new errors.JWKSTimeout()],
    ["network failure", new TypeError("fetch failed")],
    ["unexpected verifier error", new Error("boom")]
  ])("%s is a 503 with Retry-After and NO authentication challenge", async (_name, error) => {
    const handler = createMcpIngressHandler({
      authorizer: authorizerFailingWith(error),
      roundTrip: vi.fn(),
      idFactory: () => "req_f"
    });
    const response = await handler(
      new Request("https://acs.example/mcp", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a missing credential stays a bare discovery challenge with no error code", async () => {
    const handler = createMcpIngressHandler({
      authorizer: authorizerFailingWith(new Error("unused")),
      roundTrip: vi.fn(),
      idFactory: () => "req_f"
    });
    const response = await handler(new Request("https://acs.example/mcp", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}"`);
  });

  it("an unreachable bridge is a 502, never a 401", async () => {
    const authorizer = vi.fn(async () => ({ ok: true as const }));
    const handler = createMcpIngressHandler({
      authorizer,
      roundTrip: vi.fn(async () => {
        throw new Error("queue down");
      }),
      idFactory: () => "req_f"
    });
    const response = await handler(
      new Request("https://acs.example/mcp", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
      })
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});
