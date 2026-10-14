import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressConfigError, assertDirectLoopbackEgress, envProxyModeOn, nodeWouldProxy } from "./egress.js";

const PROXY = "http://proxy.invalid:3128";
const BASE = "http://127.0.0.1:11434";
const STD = "localhost,127.0.0.1,[::1]";

const verdict = (env: Record<string, string>, baseUrl = BASE, argv: string[] = []) => {
  try {
    assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY, ...env }, argv, baseUrl);
    return "allow";
  } catch (error) {
    expect(error).toBeInstanceOf(EgressConfigError);
    return "refuse";
  }
};

describe("envProxyModeOn", () => {
  it("follows Node: only NODE_USE_ENV_PROXY=1 or --use-env-proxy enables it", () => {
    expect(envProxyModeOn({ NODE_USE_ENV_PROXY: "1" }, [])).toBe(true);
    expect(envProxyModeOn({ NODE_USE_ENV_PROXY: "false" }, [])).toBe(false);
    expect(envProxyModeOn({ NODE_USE_ENV_PROXY: "true" }, [])).toBe(false);
    expect(envProxyModeOn({}, ["--use-env-proxy"])).toBe(true);
    expect(envProxyModeOn({ NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy" }, [])).toBe(true);
    expect(envProxyModeOn({ NODE_USE_ENV_PROXY: "1" }, ["--no-use-env-proxy"])).toBe(false);
  });
});

describe("assertDirectLoopbackEgress", () => {
  it("allows startup when env proxy mode is off, even with a proxy configured", () => {
    expect(() => assertDirectLoopbackEgress({ HTTP_PROXY: PROXY }, [], BASE)).not.toThrow();
    expect(verdict({ NODE_USE_ENV_PROXY: "false" })).toBe("allow");
  });

  it("allows env proxy mode with no proxy variables set, or only empty ones", () => {
    expect(() => assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1" }, [], BASE)).not.toThrow();
    expect(verdict({ HTTP_PROXY: "" })).toBe("allow");
  });

  it("refuses when NO_PROXY is unset or empty", () => {
    expect(verdict({})).toBe("refuse");
    expect(verdict({ NO_PROXY: "" })).toBe("refuse");
  });

  it("allows when NO_PROXY names the base host", () => {
    expect(verdict({ NO_PROXY: STD })).toBe("allow");
    expect(verdict({ NO_PROXY: " LOCALHOST , 127.0.0.1 " })).toBe("allow");
    expect(verdict({ NO_PROXY: STD }, "http://localhost:11434")).toBe("allow");
    expect(verdict({ NO_PROXY: ".localhost" }, "http://localhost:11434")).toBe("allow");
  });

  it("lets lowercase no_proxy win over NO_PROXY, even when empty", () => {
    expect(verdict({ NO_PROXY: STD, no_proxy: "example.com" })).toBe("refuse");
    expect(verdict({ NO_PROXY: STD, no_proxy: "" })).toBe("refuse");
    expect(verdict({ no_proxy: STD, NO_PROXY: "example.com" })).toBe("allow");
  });

  it("does not count CIDR ranges as coverage", () => {
    expect(verdict({ NO_PROXY: "localhost,127.0.0.0/8,[::1]" })).toBe("refuse");
  });

  it("does not count bare ::1 as coverage for [::1]", () => {
    expect(verdict({ NO_PROXY: "localhost,127.0.0.1,::1" }, "http://[::1]:11434")).toBe("refuse");
    expect(verdict({ NO_PROXY: STD }, "http://[::1]:11434")).toBe("allow");
  });

  it("accepts a port-qualified entry only when it matches the base URL port", () => {
    expect(verdict({ NO_PROXY: "127.0.0.1:11434" })).toBe("allow");
    expect(verdict({ NO_PROXY: "127.0.0.1:8080" })).toBe("refuse");
    expect(verdict({ NO_PROXY: "[::1]:11434" }, "http://[::1]:11434")).toBe("allow");
    expect(verdict({ NO_PROXY: "127.0.0.1:80" }, "http://127.0.0.1")).toBe("allow");
  });

  it("treats * as a wildcard only when it is the whole value", () => {
    expect(verdict({ NO_PROXY: "*" })).toBe("allow");
    expect(verdict({ NO_PROXY: "*,example.com" })).toBe("refuse");
  });

  it("checks https targets against https_proxy and falls back to the http proxy", () => {
    expect(verdict({ HTTP_PROXY: "", HTTPS_PROXY: PROXY }, "https://127.0.0.1:11434")).toBe("refuse");
    expect(verdict({ HTTP_PROXY: "", HTTPS_PROXY: PROXY })).toBe("allow");
    expect(verdict({}, "https://127.0.0.1:11434")).toBe("refuse");
  });

  it("does not echo proxy values in the error", () => {
    expect(() => assertDirectLoopbackEgress({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY }, [], BASE)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("proxy.invalid") })
    );
  });
});

// Cross-check the model against the real runtime: spawn Node with env proxy mode and a local proxy that also
// answers CONNECT, and confirm it is bypassed exactly when `nodeWouldProxy` says so.
const major = Number(process.versions.node.split(".")[0]);
describe.skipIf(major < 24)("nodeWouldProxy agrees with Node's real env-proxy dispatcher", () => {
  const servers: Server[] = [];
  let proxyPort = 0;
  let v4Port = 0;
  let v6Port = 0;

  const listen = (server: Server, host: string) =>
    new Promise<number>((resolve) => {
      server.once("error", () => resolve(0));
      server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
    });

  beforeAll(async () => {
    const proxy = createServer((_req, res) => res.end("PROXIED"));
    proxy.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nPROXIED");
    });
    const v4 = createServer((_req, res) => res.end("DIRECT"));
    const v6 = createServer((_req, res) => res.end("DIRECT"));
    servers.push(proxy, v4, v6);
    proxyPort = await listen(proxy, "127.0.0.1");
    v4Port = await listen(v4, "127.0.0.1");
    v6Port = await listen(v6, "::1");
  });

  afterAll(() => {
    for (const server of servers) server.close();
  });

  const probe = (url: string, extra: Record<string, string>) =>
    new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const r = await fetch(process.argv[1]).then((x) => x.text(), () => 'ERR'); process.stdout.write(r);",
          url
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            NODE_USE_ENV_PROXY: "1",
            HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            ...extra
          },
          timeout: 10_000
        },
        (_error, stdout) => resolve(String(stdout))
      );
    });

  it("matches for every NO_PROXY shape the guard reasons about", async () => {
    const cases: [string, Record<string, string>, boolean][] = [];
    const add = (url: string, extra: Record<string, string>, safetyOnly = false) =>
      cases.push([url, extra, safetyOnly]);
    const v4 = `http://127.0.0.1:${v4Port}/`;
    const local = `http://localhost:${v4Port}/`;
    for (const extra of [
      {},
      { NO_PROXY: STD },
      { NO_PROXY: STD, no_proxy: "example.com" },
      { NO_PROXY: STD, no_proxy: "" },
      { no_proxy: STD, NO_PROXY: "example.com" },
      { NO_PROXY: "localhost,127.0.0.0/8,[::1]" },
      { NO_PROXY: "*" },
      { NO_PROXY: "*,example.com" },
      { NO_PROXY: " LOCALHOST , 127.0.0.1 " },
      { NO_PROXY: `127.0.0.1:${v4Port}` },
      { NO_PROXY: `127.0.0.1:${v4Port + 1}` },
      { NO_PROXY: ".localhost" }
    ]) {
      add(v4, extra);
      add(local, extra);
    }
    if (v6Port) {
      const v6 = `http://[::1]:${v6Port}/`;
      // Node 24's undici parses bare `::1` as host ":" port 1 and proxies; newer Node bypasses. The guard
      // follows the stricter behavior, so here only the safe direction (never allow a proxied request) is asserted.
      add(v6, { NO_PROXY: "localhost,127.0.0.1,::1" }, true);
      add(v6, { NO_PROXY: STD });
      add(v6, { NO_PROXY: `[::1]:${v6Port}` });
      add(v6, { NO_PROXY: `[::1]:${v6Port + 1}` });
    }
    const results = await Promise.all(cases.map(([url, extra]) => probe(url, extra)));
    cases.forEach(([url, extra, safetyOnly], index) => {
      const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, ...extra };
      const expected = nodeWouldProxy(new URL(url), env) ? "PROXIED" : "DIRECT";
      if (safetyOnly && expected === "PROXIED") {
        expect(["PROXIED", "DIRECT"]).toContain(results[index]);
        return;
      }
      expect({ url, extra, got: results[index] }).toEqual({ url, extra, got: expected });
    });
  });
});
