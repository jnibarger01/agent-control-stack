import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { VercelRegion } from "@vercel/queue";

export interface BridgeDaemonCommonConfig {
  projectIdOrName: string;
  teamId?: string;
  queueRegion: VercelRegion;
  accessTokenFile: string;
  localMcpUrl: string;
  replayDbPath: string;
  pollIntervalMs: number;
}

export interface TunnelBridgeDaemonConfig extends BridgeDaemonCommonConfig {
  authMode: "tunnel";
  gatewayTokenFile: string;
  tunnelPrivateKeyFile: string;
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  heartbeatIntervalMs: number;
}

export interface OauthBridgeDaemonConfig extends BridgeDaemonCommonConfig {
  authMode: "oauth";
  authPrivateKeyFile: string;
}

export type BridgeDaemonConfig = TunnelBridgeDaemonConfig | OauthBridgeDaemonConfig;

export function loadBridgeDaemonConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeDaemonConfig {
  const projectIdOrName = required(env, "ACS_VERCEL_PROJECT");
  const accessTokenFile = absolute(required(env, "ACS_VERCEL_ACCESS_TOKEN_FILE"), cwd);
  const authMode = env.ACS_VERCEL_AUTH_MODE?.trim() || "tunnel";
  const common: BridgeDaemonCommonConfig = {
    projectIdOrName,
    ...(env.ACS_VERCEL_TEAM_ID?.trim() ? { teamId: env.ACS_VERCEL_TEAM_ID.trim() } : {}),
    queueRegion: (env.ACS_VERCEL_QUEUE_REGION?.trim() || "iad1") as VercelRegion,
    accessTokenFile,
    localMcpUrl: env.ACS_VERCEL_LOCAL_MCP_URL?.trim() || "http://127.0.0.1:3000/mcp",
    replayDbPath: absolute(env.ACS_VERCEL_REPLAY_DB?.trim() || "storage/vercel-bridge-replay.db", cwd),
    pollIntervalMs: integerInRange(env.ACS_VERCEL_POLL_INTERVAL_MS, 1_000, 100, 60_000, "ACS_VERCEL_POLL_INTERVAL_MS")
  };

  if (authMode === "oauth") {
    return {
      ...common,
      authMode: "oauth",
      authPrivateKeyFile: absolute(required(env, "ACS_VERCEL_AUTH_PRIVATE_KEY_FILE"), cwd)
    };
  }
  if (authMode !== "tunnel") {
    throw new Error("ACS_VERCEL_AUTH_MODE must be oauth or tunnel");
  }
  return {
    ...common,
    authMode: "tunnel",
    gatewayTokenFile: absolute(required(env, "ACS_VERCEL_GATEWAY_TOKEN_FILE"), cwd),
    tunnelPrivateKeyFile: absolute(required(env, "ACS_VERCEL_TUNNEL_PRIVATE_KEY_FILE"), cwd),
    connectorId: required(env, "ACS_VERCEL_CONNECTOR_ID"),
    tunnelId: required(env, "ACS_VERCEL_TUNNEL_ID"),
    sessionId: required(env, "ACS_VERCEL_SESSION_ID"),
    heartbeatIntervalMs: integerInRange(
      env.ACS_VERCEL_HEARTBEAT_INTERVAL_MS,
      300_000,
      30_000,
      600_000,
      "ACS_VERCEL_HEARTBEAT_INTERVAL_MS"
    )
  };
}
export function readOwnerOnlySecret(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`secret path is not a file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`secret file must not be group/world accessible: ${path}`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) {
    throw new Error(`secret file is empty: ${path}`);
  }
  return value;
}

export interface TunnelHeartbeatOptions {
  localMcpUrl: string;
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  gatewayBearerToken: string;
  fetchFn?: typeof fetch;
}

export function createTunnelHeartbeat(options: TunnelHeartbeatOptions) {
  const mcpUrl = requireLoopbackUrl(options.localMcpUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const path = [
    "connectors",
    encodeURIComponent(options.connectorId),
    "tunnels",
    encodeURIComponent(options.tunnelId),
    "sessions",
    encodeURIComponent(options.sessionId),
    "heartbeat"
  ].join("/");
  const heartbeatUrl = new URL(`/${path}`, mcpUrl);

  return async (): Promise<void> => {
    const response = await fetchFn(heartbeatUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.gatewayBearerToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    if (!response.ok) {
      throw new Error(`ACS tunnel heartbeat failed with status ${response.status}`);
    }
  };
}

function requireLoopbackUrl(input: string): URL {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") ||
    url.username ||
    url.password
  ) {
    throw new Error("local ACS URL must be credential-free and loopback-only");
  }
  return url;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integerInRange(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

import { UnauthorizedError } from "@vercel/queue";
import { ProjectOidcTokenProvider } from "./oidc.js";
import { createWorkerQueueClient, pollBridgeOnce, type WorkerQueuePort } from "./queue-runtime.js";
import { SqliteBridgeReplayStore } from "./replay-store.js";
import { createEncryptedAuthorizationResolver, createLocalAcsCaller } from "./worker.js";

export interface BridgeDaemonLogger {
  info(event: string): void;
  warn(event: string): void;
  error(event: string): void;
}

export interface RunBridgeDaemonOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: BridgeDaemonLogger;
  oidcProviderFactory?: (
    options: ConstructorParameters<typeof ProjectOidcTokenProvider>[0]
  ) => Pick<ProjectOidcTokenProvider, "getToken" | "invalidate">;
  queueClientFactory?: typeof createWorkerQueueClient;
  pollOnce?: typeof pollBridgeOnce;
}

export async function runBridgeDaemon(config: BridgeDaemonConfig, options: RunBridgeDaemonOptions = {}): Promise<void> {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const fetchFn = options.fetchFn ?? fetch;
  const vercelAccessToken = readOwnerOnlySecret(config.accessTokenFile);
  const replay = new SqliteBridgeReplayStore(config.replayDbPath);

  const oidc = (options.oidcProviderFactory ?? ((providerOptions) => new ProjectOidcTokenProvider(providerOptions)))({
    vercelAccessToken,
    projectIdOrName: config.projectIdOrName,
    ...(config.teamId ? { teamId: config.teamId } : {}),
    fetchFn,
    now
  });
  const queueClientFactory = options.queueClientFactory ?? createWorkerQueueClient;
  const pollOnce = options.pollOnce ?? pollBridgeOnce;

  let heartbeat: (() => Promise<void>) | undefined;
  const callAcs =
    config.authMode === "oauth"
      ? createLocalAcsCaller({
          url: config.localMcpUrl,
          authorizationResolver: createEncryptedAuthorizationResolver(readOwnerOnlySecret(config.authPrivateKeyFile)),
          fetchFn
        })
      : createLocalAcsCaller({
          url: config.localMcpUrl,
          connectorId: config.connectorId,
          tunnelId: config.tunnelId,
          sessionId: config.sessionId,
          privateKeyPem: readOwnerOnlySecret(config.tunnelPrivateKeyFile),
          fetchFn
        });

  if (config.authMode === "tunnel") {
    heartbeat = createTunnelHeartbeat({
      localMcpUrl: config.localMcpUrl,
      connectorId: config.connectorId,
      tunnelId: config.tunnelId,
      sessionId: config.sessionId,
      gatewayBearerToken: readOwnerOnlySecret(config.gatewayTokenFile),
      fetchFn
    });
  }

  let queue: WorkerQueuePort | undefined;
  let queueToken: string | undefined;
  let lastHeartbeatAt = 0;

  try {
    while (!options.signal?.aborted) {
      if (
        config.authMode === "tunnel" &&
        heartbeat &&
        (lastHeartbeatAt === 0 || now() - lastHeartbeatAt >= config.heartbeatIntervalMs)
      ) {
        try {
          await heartbeat();
          lastHeartbeatAt = now();
        } catch {
          logger.error("bridge.heartbeat_failed");
          await sleep(config.pollIntervalMs, options.signal);
          continue;
        }
      }
      try {
        const token = await oidc.getToken();
        if (!queue || token !== queueToken) {
          queue = queueClientFactory({
            region: config.queueRegion,
            token
          });
          queueToken = token;
        }

        const result = await pollOnce({
          queue,
          replay,
          callAcs,
          expectedAuthMode: config.authMode
        });
        if (!result.ok && result.reason === "empty") {
          await sleep(config.pollIntervalMs, options.signal);
        }
      } catch (error) {
        if (error instanceof UnauthorizedError || (error instanceof Error && error.name === "UnauthorizedError")) {
          oidc.invalidate();
          queue = undefined;
          queueToken = undefined;
          logger.warn("bridge.queue_token_rejected");
        } else {
          queue = undefined;
          queueToken = undefined;
          logger.error("bridge.poll_failed");
        }
        await sleep(config.pollIntervalMs, options.signal);
      }
    }
  } finally {
    replay.close();
    logger.info("bridge.stopped");
  }
}

const consoleLogger: BridgeDaemonLogger = {
  info: (event) => console.info(event),
  warn: (event) => console.warn(event),
  error: (event) => console.error(event)
};
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true }
    );
  });
}
