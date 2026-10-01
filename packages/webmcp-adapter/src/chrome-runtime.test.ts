import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  WEBMCP_FEATURE_FLAG,
  assertIsolatedChromeProfile,
  assertLoopbackChromeArguments,
  chromeArgumentList,
  chromeChildEnvironment,
  createChromeRuntime,
  defaultWebMcpProfileDir
} from "./chrome-runtime.js";
import { resolveWebMcpExecutionGate } from "./gate.js";
import { WEBMCP_LIVE_ENV, WEBMCP_LIVE_GATE_ENV, WEBMCP_GATE_CLEARED_VALUE } from "./gate.js";
import { expectCode } from "./test-support.js";

const HOME = "/home/operator";
const openGate = resolveWebMcpExecutionGate({ [WEBMCP_LIVE_ENV]: "1", [WEBMCP_LIVE_GATE_ENV]: WEBMCP_GATE_CLEARED_VALUE });
const created: string[] = [];

function scratchProfile(prefix = "webmcp-profile-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("dedicated profile isolation", () => {
  it("refuses the operator's default Chrome profile", () => {
    expectCode(() => assertIsolatedChromeProfile(`${HOME}/.config/google-chrome`, HOME), "webmcp_chrome_profile_forbidden");
    expectCode(
      () => assertIsolatedChromeProfile(`${HOME}/.config/google-chrome/Default`, HOME),
      "webmcp_chrome_profile_forbidden"
    );
    expectCode(() => assertIsolatedChromeProfile(`${HOME}/.config/chromium`, HOME), "webmcp_chrome_profile_forbidden");
  });

  it("refuses a relative or unnormalized profile path", () => {
    expectCode(() => assertIsolatedChromeProfile("relative/profile", HOME), "webmcp_chrome_profile_invalid");
    expectCode(() => assertIsolatedChromeProfile(`${HOME}/profiles/../webmcp`, HOME), "webmcp_chrome_profile_invalid");
  });

  it("creates and accepts a dedicated profile directory", () => {
    const dir = join(tmpdir(), `webmcp-dedicated-${Date.now()}`);
    created.push(dir);
    expect(assertIsolatedChromeProfile(dir, HOME)).toBeTruthy();
  });

  it("names lane profiles under the supplied scratch root", () => {
    expect(defaultWebMcpProfileDir("/var/tmp/acs", "lane-1")).toBe("/var/tmp/acs/webmcp-lane-1");
  });
});

describe("launch arguments", () => {
  const args = chromeArgumentList({
    profileDir: "/var/tmp/acs/profile",
    debuggingPort: 9333,
    startUrl: "http://127.0.0.1:8799/"
  });

  it("enables WebMCP and pins debugging to loopback", () => {
    expect(args).toContain(`--enable-features=${WEBMCP_FEATURE_FLAG}`);
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/var/tmp/acs/profile");
    expect(args).toContain("http://127.0.0.1:8799/");
    expect(() => assertLoopbackChromeArguments(args)).not.toThrow();
  });

  it("never emits remote origin overrides or sandbox-disabling flags", () => {
    expect(args.some((arg) => arg.startsWith("--remote-allow-origins"))).toBe(false);
    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--disable-web-security");
  });

  it("fails closed if debugging is bound more widely", () => {
    const exposed = args.map((arg) =>
      arg.startsWith("--remote-debugging-address=") ? "--remote-debugging-address=0.0.0.0" : arg
    );
    expectCode(() => assertLoopbackChromeArguments(exposed), "webmcp_chrome_debugging_exposed");
  });

  it("fails closed if the WebMCP feature flag is dropped", () => {
    const withoutFeature = args.filter((arg) => !arg.startsWith("--enable-features="));
    expectCode(() => assertLoopbackChromeArguments(withoutFeature), "webmcp_feature_flag_missing");
  });

  it("fails closed on forbidden flags", () => {
    expectCode(
      () => assertLoopbackChromeArguments([...args, "--remote-allow-origins=*"]),
      "webmcp_chrome_debugging_exposed"
    );
    expectCode(() => assertLoopbackChromeArguments([...args, "--no-sandbox"]), "webmcp_chrome_flag_forbidden");
  });

  it("refuses a non-loopback start URL and an invalid port", () => {
    expectCode(
      () =>
        chromeArgumentList({
          profileDir: "/var/tmp/acs/profile",
          debuggingPort: 9333,
          startUrl: "https://showroom.example/"
        }),
      "webmcp_chrome_start_url_invalid"
    );
    expectCode(
      () =>
        chromeArgumentList({ profileDir: "/var/tmp/acs/profile", debuggingPort: 80, startUrl: "http://127.0.0.1:8799/" }),
      "webmcp_chrome_port_invalid"
    );
  });
});

describe("child environment", () => {
  it("is deny-by-default and redirects HOME at the isolated profile", () => {
    const env = chromeChildEnvironment(
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        TZ: "America/Chicago",
        OPENAI_API_KEY: "sk-secret",
        SSH_AUTH_SOCK: "/run/agent.sock",
        HOME: "/home/operator",
        AWS_SECRET_ACCESS_KEY: "secret"
      },
      "/var/tmp/acs/webmcp-lane-1/profile"
    );
    expect(env.HOME).toBe("/var/tmp/acs/webmcp-lane-1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TZ).toBe("America/Chicago");
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TZ"]);
    expect(JSON.stringify(env)).not.toContain("sk-secret");
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  it("drops values carrying control separators", () => {
    const env = chromeChildEnvironment({ PATH: "/usr/bin\nrm -rf /" }, "/var/tmp/acs/profile");
    expect(env.PATH).toBeUndefined();
  });
});

describe("gate enforcement at the process boundary", () => {
  function fakeSpawner(spawned: string[][]) {
    return (_exe: string, args: readonly string[]): ChildProcess => {
      spawned.push([...args]);
      const child = new EventEmitter() as unknown as ChildProcess;
      const state = { pid: 4242, exitCode: null as number | null, signalCode: null as string | null };
      Object.assign(child, state, {
        kill: (): boolean => {
          state.signalCode = "SIGTERM";
          Object.assign(child, { signalCode: "SIGTERM" });
          return true;
        }
      });
      return child;
    };
  }

  async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
      return;
    }
    throw new Error(`expected a rejection with code ${code}`);
  }

  const baseConfig = () => ({
    executablePath: "/usr/bin/google-chrome",
    profileDir: scratchProfile(),
    debuggingPort: 9333,
    homeDir: HOME,
    startUrl: "http://127.0.0.1:8799/",
    startupTimeoutMs: 300,
    shutdownGraceMs: 50,
    env: { PATH: "/usr/bin" }
  });

  it("refuses to launch while the live-execution gate is closed", async () => {
    const spawned: string[][] = [];
    const runtime = createChromeRuntime(
      { ...baseConfig(), spawner: fakeSpawner(spawned) },
      resolveWebMcpExecutionGate({ [WEBMCP_LIVE_ENV]: "1" })
    );
    await rejectsWithCode(runtime.start(), "webmcp_live_execution_gate_closed");
    await rejectsWithCode(runtime.ensureRunning(), "webmcp_live_execution_gate_closed");
    await rejectsWithCode(runtime.connect(), "webmcp_live_execution_gate_closed");
    expect(spawned).toHaveLength(0);
  });

  it("refuses a non-executable Chrome path", () => {
    expectCode(
      () =>
        createChromeRuntime(
          { ...baseConfig(), executablePath: "/usr/bin/definitely-not-chrome" },
          openGate
        ),
      "webmcp_chrome_executable_missing"
    );
  });

  it("is a no-op to close before any launch", async () => {
    const runtime = createChromeRuntime({ ...baseConfig(), spawner: fakeSpawner([]) }, openGate);
    expect(runtime.status().running).toBe(false);
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("reports an unavailable runtime when Chrome never opens its debugging port", async () => {
    const spawned: string[][] = [];
    const runtime = createChromeRuntime({ ...baseConfig(), spawner: fakeSpawner(spawned) }, openGate);
    await expect(runtime.start()).rejects.toThrow(/runtime_unavailable|debugging port/u);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--remote-debugging-address=127.0.0.1");
    await runtime.close();
  });
});
