/**
 * Network profile guard (kernel issue #4).
 *
 * When a capability grants network==='none', enforcement is layered:
 *  1. spawn environments are scrubbed of proxy/network identity settings,
 *  2. on Linux, the command can be wrapped in `unshare -n` (probed first),
 *  3. explicit network binaries are blocklisted and rejected.
 * Degradation (e.g. unshare unavailable or unprivileged netns denied) is
 * ALWAYS reported via `degraded: true` — never silently claimed as blocked.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const NETWORK_BLOCKLIST_BINARIES: readonly string[] = Object.freeze([
  'curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'sftp', 'ftp', 'telnet',
]);

const PROXY_ENV_VARS: readonly string[] = Object.freeze([
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'FTP_PROXY', 'ftp_proxy',
  'ALL_PROXY', 'all_proxy',
  'SOCKS_PROXY', 'socks_proxy',
  'NO_PROXY', 'no_proxy',
]);

export interface SpawnEnvironmentResult {
  env: Record<string, string>;
  degraded: boolean;
  removedKeys: string[];
}

/**
 * Returns a copy of `env` with every proxy variable removed and no-proxy
 * wildcards forced. Use for any spawn whose capability grants network==='none'.
 */
export function scrubEnvironmentForNoNetwork(
  env: Record<string, string> = { ...process.env as Record<string, string> },
): SpawnEnvironmentResult {
  const next: Record<string, string> = { ...env };
  const removedKeys: string[] = [];
  for (const key of PROXY_ENV_VARS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      removedKeys.push(key);
    }
  }
  next.NO_PROXY = '*';
  next.no_proxy = '*';
  return { env: next, degraded: false, removedKeys };
}

export interface CommandWrapOptions {
  allowsSandbox?: boolean;
  platform?: NodeJS.Platform;
  unsharePath?: string;
  probe?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
}

export interface SandboxWrapResult {
  argv: string[];
  wrapped: boolean;
  degraded: boolean;
  reason: string;
}

let cachedProbeResult: boolean | undefined;

async function defaultProbe(argv: readonly string[]): Promise<{ ok: boolean }> {
  try {
    await execFileAsync(argv[0], argv.slice(1), { timeout: 5_000 });
    return { ok: true };
  } catch (error) {
    // Exit code 1 from `unshare -n true` means netns creation was denied;
    // ENOENT means the binary is missing. Either way it is not usable.
    const err = error as NodeJS.ErrnoException & { code?: string | number };
    void err;
    return { ok: false };
  }
}

export async function isUnshareNetworkSandboxAvailable(options: CommandWrapOptions = {}): Promise<boolean> {
  if (cachedProbeResult !== undefined && options.probe === undefined) return cachedProbeResult;
  const probe = options.probe ?? defaultProbe;
  const unshare = options.unsharePath ?? 'unshare';
  const { ok } = await probe([unshare, '-n', 'true']);
  if (options.probe === undefined) cachedProbeResult = ok;
  return ok;
}

/**
 * Wraps `argv` in `unshare -n` when network isolation is available and
 * allowed. The result degrades (degraded=true) instead of silently claiming
 * isolation when unshare is missing or the probe fails.
 */
export async function buildSandboxCommand(
  argv: readonly string[],
  options: CommandWrapOptions = {},
): Promise<SandboxWrapResult> {
  if (!options.allowsSandbox) {
    return { argv: [...argv], wrapped: false, degraded: true, reason: 'sandbox disabled by configuration' };
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return { argv: [...argv], wrapped: false, degraded: true, reason: `network namespace isolation unsupported on ${platform}` };
  }
  const probe = options.probe ?? defaultProbe;
  const unshare = options.unsharePath ?? 'unshare';
  let usable: boolean;
  if (options.probe) {
    usable = (await probe([unshare, '-n', 'true'])).ok;
  } else {
    usable = await isUnshareNetworkSandboxAvailable({ unsharePath: options.unsharePath });
  }
  if (!usable) {
    return { argv: [...argv], wrapped: false, degraded: true, reason: 'unshare -n probe failed; network namespace isolation unavailable (permissions or missing binary)' };
  }
  return { argv: [unshare, '-n', ...argv], wrapped: true, degraded: false, reason: 'wrapped in unshare -n' };
}

export interface NetworkBinaryCheck {
  ok: boolean;
  reason?: string;
  binary?: string;
}

/**
 * Word-boundary regex per blocklisted binary basename. Scanning the RAW
 * command string (not argv tokens) catches obfuscations like `"curl`,
 * `(/usr/bin/curl`, `x=curl`, `$IFS`-joined paths, etc. that token-splitting
 * misses. The boundary class [^\w/-] lets absolute paths like /usr/bin/curl
 * match while preventing false hits inside words like `curlfoo` or `my-curl`.
 */
function blocklistRegex(binary: string): RegExp {
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Preceding char may be '/' (absolute/relative paths like /usr/bin/curl)
  // but not a word char or '-' (so curlfoo / my-curl do not match).
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w]|$)`);
}

/** Rejects blocklisted network binaries appearing anywhere in the raw command string. */
export function checkNetworkBinariesInRaw(command: string, networkProfile: string): NetworkBinaryCheck {
  if (networkProfile !== 'none') return { ok: true };
  for (const binary of NETWORK_BLOCKLIST_BINARIES) {
    if (blocklistRegex(binary).test(command)) {
      return {
        ok: false,
        reason: `binary '${binary}' is blocklisted because the capability grants network='none'`,
        binary,
      };
    }
  }
  return { ok: true };
}

/** Rejects explicit network binaries when the profile is 'none'. */
export function checkNetworkBinaries(argv: readonly string[], networkProfile: string): NetworkBinaryCheck {
  if (networkProfile !== 'none') return { ok: true };
  for (const entry of argv) {
    const binary = basename(String(entry));
    if (NETWORK_BLOCKLIST_BINARIES.includes(binary)) {
      return { ok: false, reason: `binary '${binary}' is blocklisted because the capability grants network='none'`, binary };
    }
  }
  return { ok: true };
}

export interface NetworkGuardSummary {
  profile: string;
  /** Whether `unshare -n` netns isolation is actually usable on this host. */
  sandboxAvailable: boolean;
  /**
   * True when the configured profile cannot actually be enforced. A
   * non-sandboxed 'none' profile is DEGRADED (blocklist + env-scrub only),
   * never silently claimed as enforced.
   */
  degraded: boolean;
}

/**
 * Honest degradation summary for the active network profile. Attached to
 * enforcement pass decisions and audit attest events whenever the profile is
 * 'none' so downstream consumers can see exactly what was (and was not)
 * enforced.
 */
export async function networkGuardSummary(profile: string): Promise<NetworkGuardSummary> {
  let sandboxAvailable = false;
  if (profile === 'none' && process.platform === 'linux') {
    try {
      sandboxAvailable = await isUnshareNetworkSandboxAvailable();
    } catch {
      sandboxAvailable = false;
    }
  }
  return {
    profile,
    sandboxAvailable,
    degraded: profile === 'none' && !sandboxAvailable,
  };
}
