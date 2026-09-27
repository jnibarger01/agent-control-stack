/**
 * Jace Commander endpoint/profile configuration.
 *
 * Defaults describe the jacen-ubuntu host as it exists in the sibling repos:
 *   - public MCP edge: Tailscale Funnel https://jacen-ubuntu.tailaa6d41.ts.net
 *     (desktop-commander-mcp-gateway server.js OAuth AS + proxy)
 *   - ACS gateway, codex-swarm API, visualizer: loopback on the same host
 *
 * Every value is overridable by environment. Nothing here is a secret;
 * tokens come from the credential store (device login) or env at call time.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TAILNET_HOST = 'jacen-ubuntu.tailaa6d41.ts.net';

export interface JcConfig {
  /** Home of the user JC runs as (env HOME, else the OS account home). */
  homeDir: string;
  stateDir: string;
  publicMcpUrl: string;
  acsUrl: string;
  swarmUrl: string;
  visualizerUrl: string | undefined;
  missionRouterDir: string;
  traceRoots: string[];
  /** Filesystem roots the fs.read tools may touch (JC_FS_ROOTS). Empty: fs tools fail closed. */
  fsRoots: string[];
  /** Extra denied roots (JC_FS_DENIED_ROOTS), on top of the built-in credential/state denials. */
  fsDeniedRoots: string[];
  runtimeId: string;
  acsPublicKey: string | undefined;
  acsKeyId: string | undefined;
  privilegedHelperPath: string;
  sudoPath: string;
  requestTimeoutMs: number;
}

function httpUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  if (url.username || url.password) throw new Error(`${name} must not embed credentials`);
  return url.toString().replace(/\/$/, '');
}

function splitRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).map((root) => {
    if (!path.isAbsolute(root)) throw new Error(`filesystem roots must be absolute paths: ${root}`);
    return path.resolve(root);
  });
}

export function loadJcConfig(env: NodeJS.ProcessEnv = process.env): JcConfig {
  const home = os.homedir();
  const stateDir = path.resolve(env.JC_STATE_DIR ?? path.join(home, '.jace-commander'));
  const timeout = Number(env.JC_REQUEST_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) throw new Error('JC_REQUEST_TIMEOUT_MS must be an integer in [100, 60000]');
  const runtimeId = env.JC_RUNTIME_ID ?? `jc-${os.hostname().replace(/[^A-Za-z0-9._:-]/g, '-')}`.slice(0, 128);
  return {
    homeDir: env.HOME ? path.resolve(env.HOME) : home,
    stateDir,
    publicMcpUrl: httpUrl(env.JC_PUBLIC_MCP_URL ?? `https://${DEFAULT_TAILNET_HOST}/jc/mcp`, 'JC_PUBLIC_MCP_URL'),
    acsUrl: httpUrl(env.JC_ACS_URL ?? 'http://127.0.0.1:3000', 'JC_ACS_URL'),
    swarmUrl: httpUrl(env.JC_SWARM_URL ?? 'http://127.0.0.1:9711', 'JC_SWARM_URL'),
    // The visualizer binds an ephemeral port unless pinned; no safe default.
    visualizerUrl: env.JC_VISUALIZER_URL ? httpUrl(env.JC_VISUALIZER_URL, 'JC_VISUALIZER_URL') : undefined,
    missionRouterDir: path.resolve(env.JC_MISSION_ROUTER_DIR ?? path.join(home, '.mission-router')),
    traceRoots: (env.JC_TRACE_ROOTS ?? [
      path.join(home, '.looptrace'),
      path.join(home, '.mission-router'),
      path.join(stateDir, 'traces'),
    ].join(path.delimiter)).split(path.delimiter).filter(Boolean).map((root) => path.resolve(root)),
    fsRoots: splitRoots(env.JC_FS_ROOTS),
    fsDeniedRoots: splitRoots(env.JC_FS_DENIED_ROOTS),
    runtimeId,
    acsPublicKey: env.JC_ACS_PUBLIC_KEY,
    acsKeyId: env.JC_ACS_KEY_ID,
    privilegedHelperPath: env.JC_PRIVILEGED_HELPER ?? '/usr/local/libexec/jace-commander/jc-privileged-helper',
    sudoPath: env.JC_SUDO_PATH ?? '/usr/bin/sudo',
    requestTimeoutMs: timeout,
  };
}
