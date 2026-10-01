import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { WebMcpError, WebMcpErrorCode } from "./contracts.js";
import { assertLoopbackEndpoint } from "./cdp.js";
import { connectCdp, type CdpConnection, type WebSocketLike } from "./cdp-client.js";
import { WEBMCP_LIVE_ENV, assertWebMcpExecutionGate, requireLiveWebMcpGate, type WebMcpExecutionGate } from "./gate.js";

/**
 * Chrome lifecycle — the narrow, explicit process-creation boundary.
 *
 * This mirrors `packages/desktop-commander-adapter`, which owns spawning its
 * MCP runtime over stdio: ACS adapter packages own process creation, and
 * gateway/protocol/policy code never spawns (AGENTS.md, "Sandbox and Process
 * Execution"). The gateway reaches WebMCP only through this adapter.
 *
 * Guarantees enforced here:
 *   - the browser is a child of the ACS process and dies with it;
 *   - a dedicated profile directory, never the operator's default profile;
 *   - `--enable-features=WebMCP` is the only feature override;
 *   - remote debugging is bound to loopback with no public/relay listener;
 *   - the child environment is deny-by-default (explicit allowlist only);
 *   - nothing launches while the live-execution gate is closed.
 */

/** The `WebMCP` feature flag. Launch fails closed if it is dropped. */
export const WEBMCP_FEATURE_FLAG = "WebMCP";

export const chromeEnvironmentAllowlist = ["PATH", "LANG", "LC_ALL", "TZ", "NO_COLOR"] as const;

/** Chrome profile roots that must never be used by the executor. */
const FORBIDDEN_PROFILE_SUFFIXES = [
  "/.config/google-chrome",
  "/.config/google-chrome-beta",
  "/.config/google-chrome-unstable",
  "/.config/google-chrome-for-testing",
  "/.config/chromium"
];

export interface ChromeRuntimeConfig {
  /** Absolute path to the installed Chrome binary. */
  executablePath: string;
  /** Absolute, normalized, dedicated profile directory. Created if absent. */
  profileDir: string;
  /** Loopback debugging port. */
  debuggingPort: number;
  /** Operator home directory, used only to prove the profile is not the default one. */
  homeDir: string;
  /** Page the executor is pinned to. */
  startUrl: string;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: replaces process creation entirely. */
  spawner?: ChromeSpawner;
  /** Test seam: replaces WebSocket construction. */
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface ChromeSpawner {
  (executablePath: string, args: readonly string[], env: Record<string, string>): ChildProcess;
}

export interface ChromeRuntimeStatus {
  running: boolean;
  pid?: number;
  port: number;
  profileDir: string;
  executablePath: string;
  launchedAt?: string;
}

export interface ChromeRuntime {
  status(): ChromeRuntimeStatus;
  /** Start (or restart) the browser. Requires a cleared live-execution gate. */
  start(): Promise<ChromeRuntimeStatus>;
  /** Recover a dead browser; bounded, never concurrent. */
  ensureRunning(): Promise<ChromeRuntimeStatus>;
  /** Open a CDP session to the active page target. */
  connect(): Promise<CdpConnection>;
  /** Idempotent shutdown. Kills the process group; safe to call from process exit. */
  close(): Promise<void>;
}

function requireExecutable(filePath: string): string {
  if (!isAbsolute(filePath) || normalize(filePath) !== filePath) {
    throw new ControlStackError("webmcp_chrome_executable_invalid", "Chrome executable path must be absolute and normalized");
  }
  try {
    accessSync(filePath, constants.X_OK);
  } catch {
    throw new ControlStackError("webmcp_chrome_executable_missing", `Chrome executable is not runnable: ${filePath}`);
  }
  return filePath;
}

/**
 * A dedicated profile is a security property, not a convenience. Refuse the
 * operator's default Chrome profile roots outright, including via a symlink.
 */
export function assertIsolatedChromeProfile(profileDir: string, homeDir: string): string {
  if (!isAbsolute(profileDir) || normalize(profileDir) !== profileDir) {
    throw new ControlStackError(
      "webmcp_chrome_profile_invalid",
      "WebMCP profile directory must be absolute and normalized"
    );
  }
  const defaultRoots = FORBIDDEN_PROFILE_SUFFIXES.map((suffix) => `${homeDir}${suffix}`);
  for (const root of defaultRoots) {
    if (profileDir === root || profileDir.startsWith(`${root}/`)) {
      throw new ControlStackError(
        "webmcp_chrome_profile_forbidden",
        "WebMCP must never use the operator's default Chrome profile"
      );
    }
  }
  mkdirSync(profileDir, { recursive: true });
  const real = realpathSync(profileDir);
  if (!statSync(real).isDirectory()) {
    throw new ControlStackError("webmcp_chrome_profile_invalid", "WebMCP profile path is not a directory");
  }
  for (const root of defaultRoots) {
    let realRoot: string | undefined;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(`${realRoot}/`)) {
      throw new ControlStackError(
        "webmcp_chrome_profile_forbidden",
        "WebMCP profile directory resolves into the operator's default Chrome profile"
      );
    }
  }
  return real;
}

/**
 * The exact argv. Debugging is pinned to `127.0.0.1`; there is no argument
 * that can open a public or relay listener, and `--remote-allow-origins=*` is
 * deliberately never emitted.
 */
export function chromeArgumentList(config: Pick<ChromeRuntimeConfig, "profileDir" | "debuggingPort" | "startUrl">): string[] {
  if (!Number.isInteger(config.debuggingPort) || config.debuggingPort < 1024 || config.debuggingPort > 65_535) {
    throw new ControlStackError("webmcp_chrome_port_invalid", "debugging port must be an unprivileged TCP port");
  }
  if (!config.startUrl.startsWith("http://127.0.0.1") && !config.startUrl.startsWith("http://localhost")) {
    throw new ControlStackError(
      "webmcp_chrome_start_url_invalid",
      "WebMCP start URL must be a loopback page owned by the isolated test/lane host"
    );
  }
  return [
    "--headless=new",
    `--user-data-dir=${config.profileDir}`,
    `--remote-debugging-port=${config.debuggingPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--enable-features=${WEBMCP_FEATURE_FLAG}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-extensions",
    "--noerrdialogs",
    config.startUrl
  ];
}

/** Fail closed if a launch would ever expose debugging or drop the feature flag. */
export function assertLoopbackChromeArguments(args: readonly string[]): void {
  const addressArg = args.find((arg) => arg.startsWith("--remote-debugging-address="));
  if (addressArg !== "--remote-debugging-address=127.0.0.1") {
    throw new ControlStackError(
      "webmcp_chrome_debugging_exposed",
      "Chrome remote debugging must be bound to 127.0.0.1"
    );
  }
  if (!args.includes(`--enable-features=${WEBMCP_FEATURE_FLAG}`)) {
    throw new ControlStackError("webmcp_feature_flag_missing", "Chrome must launch with --enable-features=WebMCP");
  }
  if (args.some((arg) => arg.startsWith("--remote-allow-origins="))) {
    throw new ControlStackError("webmcp_chrome_debugging_exposed", "remote origin overrides are not permitted");
  }
  for (const forbidden of ["--remote-debugging-pipe", "--no-sandbox", "--disable-web-security"]) {
    if (args.includes(forbidden)) {
      throw new ControlStackError("webmcp_chrome_flag_forbidden", `forbidden Chrome flag: ${forbidden}`);
    }
  }
}

/**
 * Deny-by-default child environment. `HOME` is redirected at the isolated
 * profile parent so that even a mistaken default-profile lookup cannot reach
 * the operator's real Chrome state.
 */
export function chromeChildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  profileDir: string
): Record<string, string> {
  const child: Record<string, string> = { HOME: resolve(profileDir, "..") };
  for (const name of chromeEnvironmentAllowlist) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value)) {
      child[name] = value;
    }
  }
  return child;
}

interface DebugTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export function createChromeRuntime(config: ChromeRuntimeConfig, gate: WebMcpExecutionGate): ChromeRuntime {
  const executablePath = requireExecutable(config.executablePath);
  const profileDir = assertIsolatedChromeProfile(config.profileDir, config.homeDir);
  const args = chromeArgumentList({ ...config, profileDir });
  assertLoopbackChromeArguments(args);
  const childEnv = chromeChildEnvironment(config.env ?? {}, profileDir);
  const spawner: ChromeSpawner =
    config.spawner ??
    ((exe, argv, env) =>
      spawn(exe, [...argv], {
        env,
        detached: false,
        stdio: ["ignore", "ignore", "ignore"]
      }));

  let child: ChildProcess | undefined;
  let launchedAt: string | undefined;
  let starting: Promise<ChromeRuntimeStatus> | undefined;

  const isAlive = (): boolean => child !== undefined && child.exitCode === null && child.signalCode === null;

  async function fetchVersion(): Promise<{ browser: string } | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:${config.debuggingPort}/json/version`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { Browser?: unknown };
      return typeof body.Browser === "string" ? { browser: body.Browser } : undefined;
    } catch {
      return undefined;
    }
  }

  async function listTargets(): Promise<DebugTarget[]> {
    const response = await fetch(`http://127.0.0.1:${config.debuggingPort}/json/list`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) {
      throw new WebMcpError(WebMcpErrorCode.RuntimeUnavailable, "Chrome target list is unavailable");
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new WebMcpError(WebMcpErrorCode.RuntimeUnavailable, "Chrome target list was malformed");
    }
    return body as DebugTarget[];
  }

  async function waitForDevTools(): Promise<void> {
    const deadline = Date.now() + (config.startupTimeoutMs ?? 20_000);
    for (;;) {
      if (!isAlive()) {
        throw new WebMcpError(WebMcpErrorCode.RuntimeUnavailable, "Chrome exited before its debugging port opened");
      }
      if (await fetchVersion()) return;
      if (Date.now() >= deadline) {
        throw new WebMcpError(WebMcpErrorCode.RuntimeUnavailable, "Chrome debugging port did not become ready");
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function start(): Promise<ChromeRuntimeStatus> {
    requireLiveWebMcpGate(gate);
    if (isAlive()) return status();
    if (starting) return starting;
    starting = (async () => {
      try {
        child = spawner(executablePath, args, childEnv);
        child.on("error", () => {
          child = undefined;
        });
        await waitForDevTools();
        launchedAt = new Date().toISOString();
        return status();
      } catch (error) {
        await close();
        throw error;
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  }

  function status(): ChromeRuntimeStatus {
    return {
      running: isAlive(),
      pid: child?.pid,
      port: config.debuggingPort,
      profileDir,
      executablePath,
      launchedAt
    };
  }

  async function ensureRunning(): Promise<ChromeRuntimeStatus> {
    requireLiveWebMcpGate(gate);
    if (isAlive() && (await fetchVersion())) return status();
    // Recoverable: a crashed browser is replaced, never reused half-dead.
    child = undefined;
    launchedAt = undefined;
    return start();
  }

  async function connect(): Promise<CdpConnection> {
    requireLiveWebMcpGate(gate);
    await ensureRunning();
    const targets = await listTargets();
    const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
    if (!page?.webSocketDebuggerUrl) {
      throw new WebMcpError(WebMcpErrorCode.RuntimeUnavailable, "no debuggable page target is available");
    }
    const url = assertLoopbackEndpoint(page.webSocketDebuggerUrl);
    return connectCdp(url, { webSocketFactory: config.webSocketFactory });
  }

  async function close(): Promise<void> {
    const dying = child;
    child = undefined;
    launchedAt = undefined;
    if (!dying || dying.exitCode !== null) return;
    const pid = dying.pid;
    dying.kill("SIGTERM");
    const deadline = Date.now() + (config.shutdownGraceMs ?? 5_000);
    while (dying.exitCode === null && dying.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (dying.exitCode === null && dying.signalCode === null) {
      try {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
        else dying.kill("SIGKILL");
      } catch {
        try {
          dying.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  return { status, start, ensureRunning, connect, close };
}

/** Gateway/worker startup helper: assert the gate before wiring the runtime. */
export function assertWebMcpRuntimeGate(gate: WebMcpExecutionGate, env: Readonly<Record<string, string | undefined>>): void {
  if (env[WEBMCP_LIVE_ENV] !== undefined) {
    assertWebMcpExecutionGate(gate);
  }
}

export function defaultWebMcpProfileDir(scratchRoot: string, laneId: string): string {
  return join(scratchRoot, `webmcp-${laneId}`);
}
