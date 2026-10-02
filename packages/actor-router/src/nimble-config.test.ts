import { describe, expect, it } from "vitest";
import { NimbleRoutingConfigError, resolveNimbleRoutingConfig } from "./nimble-config.js";

describe("resolveNimbleRoutingConfig", () => {
  it("stays disabled without validating unused routing settings", () => {
    expect(
      resolveNimbleRoutingConfig({
        ACS_NIMBLE_ROUTING_ENABLED: "0",
        ACS_NIMBLE_URL: "not a url",
        ACS_NIMBLE_CONFIDENCE_THRESHOLD: "9"
      }).enabled
    ).toBe(false);
  });

  it("rejects enabled configuration that cannot route unambiguously", () => {
    expect(() => resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "yes" })).toThrow(NimbleRoutingConfigError);
    expect(() =>
      resolveNimbleRoutingConfig({
        ACS_NIMBLE_ROUTING_ENABLED: "1",
        ACS_NIMBLE_URL: "http://user:pass@127.0.0.1:11434/v1/systemone"
      })
    ).toThrow(/credentials/);
    expect(() => resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1", ACS_NIMBLE_TIMEOUT_MS: "0" })).toThrow(
      /ACS_NIMBLE_TIMEOUT_MS/
    );
    expect(() =>
      resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1", ACS_NIMBLE_CONFIDENCE_THRESHOLD: "1.2" })
    ).toThrow(/ACS_NIMBLE_CONFIDENCE_THRESHOLD/);
    expect(() =>
      resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1", ACS_NIMBLE_LOW_CONFIDENCE_POLICY: "ignore" })
    ).toThrow(/ACS_NIMBLE_LOW_CONFIDENCE_POLICY/);
    expect(() =>
      resolveNimbleRoutingConfig({ ACS_NIMBLE_ROUTING_ENABLED: "1", ACS_NIMBLE_FALLBACK_MODE: "random" })
    ).toThrow(/ACS_NIMBLE_FALLBACK_MODE/);
  });
});
