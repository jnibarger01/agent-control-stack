import { describe, expect, it } from "vitest";
import { loadHostedGatewayConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://user:pass@example.neon.tech/neondb?sslmode=require",
  ACS_OAUTH_ISSUER: "https://jace-auth.vercel.app",
  ACS_OAUTH_AUDIENCE: "https://agent-control-stack-gateway-jace-nibargers-projects.vercel.app",
  ACS_OAUTH_JWKS_URI: "https://jace-auth.vercel.app/jwks"
};

describe("loadHostedGatewayConfig", () => {
  it("accepts the Vercel + Neon + OAuth production contract", () => {
    const config = loadHostedGatewayConfig(base);
    expect(config.oauthIssuer).toBe("https://jace-auth.vercel.app");
    expect(config.publicOrigin).toBe(base.ACS_OAUTH_AUDIENCE);
    expect(config.maxPendingWorkItems).toBe(250);
  });

  it.each([
    "ACS_AUTH_MODE",
    "ACS_TRUSTED_TUNNEL_PROXY",
    "ACS_ALLOWED_TUNNEL_IDS",
    "ACS_TUNNEL_SCOPES",
    "ACS_ALLOW_UNSIGNED_TUNNEL_ID_DEV"
  ])("fails closed when hosted deployment contains %s", (key) => {
    expect(() => loadHostedGatewayConfig({ ...base, [key]: key === "ACS_AUTH_MODE" ? "tunnel_id" : "configured" })).toThrow(
      "not supported by the hosted ACS gateway"
    );
  });

  it("requires HTTPS OAuth endpoints", () => {
    expect(() => loadHostedGatewayConfig({ ...base, ACS_OAUTH_ISSUER: "http://auth.example.test" })).toThrow(
      "ACS_OAUTH_ISSUER must use HTTPS"
    );
  });
});
