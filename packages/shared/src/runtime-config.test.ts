import { describe, expect, it } from "vitest";
import { formatRuntimeConfigIssues, loadRuntimeConfig, redactRuntimeConfig } from "./runtime-config.js";

describe("canonical runtime configuration", () => {
  it("applies identical defaults for every process", () => {
    expect(loadRuntimeConfig({})).toMatchObject({
      version: 1,
      gateway: { host: "127.0.0.1", port: 3000 },
      database: { path: "storage/local.db" },
      environment: "development"
    });
  });

  it("rejects unknown ACS keys only in production", () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", ACS_TYPO: "1" })).toThrow("ACS_TYPO");
    expect(loadRuntimeConfig({ NODE_ENV: "development", ACS_TYPO: "1" })).toBeDefined();
  });

  it("validates cross-field authentication combinations", () => {
    expect(() => loadRuntimeConfig({ ACS_AUTH_MODE: "oauth", ACS_OAUTH_ISSUER: "https://issuer.example" })).toThrow(
      "OAuth issuer"
    );
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        ACS_GATEWAY_TOKEN: "secret",
        ACS_AUTH_MODE: "local_bearer"
      })
    ).toThrow("local bearer");
    expect(
      loadRuntimeConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        ACS_OAUTH_ISSUER: "https://issuer.example",
        ACS_OAUTH_AUDIENCE: "https://acs.example",
        ACS_OAUTH_JWKS_URI: "https://issuer.example/jwks"
      }).auth.mode
    ).toBe("oauth");
  });

  it("redacts secret diagnostics", () => {
    const config = loadRuntimeConfig({ ACS_GATEWAY_TOKEN: "secret" });
    expect(redactRuntimeConfig(config).auth.localBearerToken).toBe("[REDACTED]");
    expect(
      formatRuntimeConfigIssues({ issues: [{ path: ["auth"], message: "bad", code: "custom" }] } as never)
    ).toContain("auth: bad");
  });
});
