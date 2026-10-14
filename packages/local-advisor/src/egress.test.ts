import { describe, expect, it } from "vitest";
import { EgressConfigError, assertDirectLoopbackEgress, noProxyCoversLoopback } from "./egress.js";

const PROXY = "http://proxy.invalid:3128";

describe("assertDirectLoopbackEgress", () => {
  it("allows startup when env proxy mode is off, even with a proxy configured", () => {
    expect(() => assertDirectLoopbackEgress({ HTTP_PROXY: PROXY })).not.toThrow();
  });

  it("allows env proxy mode with no proxy variables set", () => {
    expect(() => assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1" })).not.toThrow();
  });

  it.each([
    [{ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY }, []],
    [{ HTTPS_PROXY: PROXY }, ["--use-env-proxy"]],
    [{ NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy", http_proxy: PROXY }, []],
    [{ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY, NO_PROXY: "localhost" }, []]
  ] as const)("refuses env proxy mode when NO_PROXY misses loopback (%j %j)", (env, argv) => {
    expect(() => assertDirectLoopbackEgress(env, argv)).toThrow(EgressConfigError);
  });

  it("does not echo proxy values in the error", () => {
    expect(() => assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("proxy.invalid") })
    );
  });

  it.each(["127.0.0.1,localhost,::1", "*", " LOCALHOST , [::1] , 127.0.0.0/8 ", ".localhost,127.0.0.1:11434,::1"])(
    "allows env proxy mode when NO_PROXY=%s covers loopback",
    (noProxy) => {
      expect(noProxyCoversLoopback(noProxy)).toBe(true);
      expect(() => assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY, no_proxy: noProxy })).not.toThrow();
    }
  );
});
