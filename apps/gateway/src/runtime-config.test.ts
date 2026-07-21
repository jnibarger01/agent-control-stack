import { describe, expect, it } from "vitest";
import { gatewayListenConfig } from "./runtime-config.js";

describe("gateway runtime configuration", () => {
  it("uses explicit bounded listen settings", () => {
    expect(gatewayListenConfig({})).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(gatewayListenConfig({ HOST: "localhost", PORT: "8080" })).toEqual({ host: "localhost", port: 8080 });
    expect(() => gatewayListenConfig({ PORT: "0" })).toThrow();
    expect(() => gatewayListenConfig({ PORT: "not-a-port" })).toThrow();
  });

  it("fails closed for unauthenticated production startup", () => {
    expect(() => gatewayListenConfig({ NODE_ENV: "production", HOST: "0.0.0.0" })).toThrow(
      "ACS_GATEWAY_TOKEN is required"
    );
    expect(() =>
      gatewayListenConfig({ NODE_ENV: "production", HOST: "0.0.0.0", ACS_GATEWAY_TOKEN: "dashboard" })
    ).toThrow("requires complete OAuth or trusted tunnel authentication");
    expect(() =>
      gatewayListenConfig({ NODE_ENV: "production", HOST: "127.0.0.1", ACS_GATEWAY_TOKEN: "dashboard" })
    ).toThrow("requires complete OAuth or trusted tunnel authentication");
    expect(
      gatewayListenConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        ACS_GATEWAY_TOKEN: "dashboard",
        ACS_OAUTH_ISSUER: "https://issuer.example",
        ACS_OAUTH_AUDIENCE: "https://acs.example/mcp",
        ACS_OAUTH_JWKS_URI: "https://issuer.example/jwks"
      })
    ).toEqual({ host: "0.0.0.0", port: 3000 });
  });
});
