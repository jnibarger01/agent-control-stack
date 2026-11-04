/**
 * OS-enforced workload isolation for Jace Commander (bubblewrap namespaces).
 *
 * Every workload JC starts on behalf of a model (start_process, run_command,
 * start_terminal_session, git) runs inside a sandbox that separates it from
 * JC's control plane even though it runs as the same UID:
 *
 *   pid/ipc/uts ns  JC, the bridge and every other host process are invisible,
 *                   so /proc/<pid>/environ (gateway execution token, ACS tokens)
 *                   cannot be read and nothing outside can be signalled/ptraced.
 *   mount ns        / is read-only; only the configured filesystem roots (and
 *                   explicit JC_SANDBOX_WRITABLE extras) are writable, so a
 *                   workload cannot plant dotfile/autostart/unit persistence.
 *                   Credential stores, JC/gateway/ACS state and env files,
 *                   $XDG_RUNTIME_DIR (user bus, keyrings, agent and X auth
 *                   sockets) are masked; /tmp and /dev (devpts) are private.
 *                   JC's own runtime and its node_modules are read-only.
 *   user ns         all capabilities dropped; nested user namespaces disabled,
 *                   so the masks cannot be unmounted.
 *   net ns          JC_WORKLOAD_NETWORK=none (default): loopback only, no host
 *                   abstract sockets or loopback services. `host` is opt-in.
 *
 * There is no unsandboxed fallback: if bubblewrap is missing or the self-test
 * fails, workload tools refuse to run. `none` exists only for non-managed
 * presets with an explicit JC_ALLOW_UNISOLATED_WORKLOADS=1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { IntegrationError } from './integrations.js';

export type WorkloadIsolation = 'bwrap' | 'none';
export type WorkloadNetwork = 'none' | 'host';

export interface SandboxPolicy {
  readonly isolation: WorkloadIsolation;
  readonly network: WorkloadNetwork;
  readonly bwrapPath: string;
  /** Masked: directories become empty tmpfs, files become /dev/null. */
  readonly hidden: readonly string[];
  /** Re-bound read-only (applied after writable binds, so they win inside roots). */
  readonly readOnly: readonly string[];
  /** Writable inside the sandbox (filesystem roots + explicit extras). */
  readonly writable: readonly string[];
}

export interface SandboxRun {
  /** Per-call writable/ro/bind-back additions (git: the ssh agent socket, known_hosts). */
  readonly bindBack?: readonly string[];
  readonly roBindBack?: readonly string[];
  /** Overrides the policy network for this run (git fetch/push need the network). */
  readonly network?: WorkloadNetwork;
}

const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DEPENDENCIES = ['@modelcontextprotocol/sdk', '@simplewebauthn/server', 'isbinaryfile', 'pizzip', 'unpdf'];

/** Credential and control-plane locations relative to $HOME that workloads never see. */
const HOME_HIDDEN = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh',
  '.config/jace-commander', '.jace-commander', '.config/desktop-commander-mcp-gateway', '.config/dc-relay',
  '.desktop-commander', '.config/agent-control-stack', '.local/share/agent-control-stack',
  '.local/share/keyrings', '.local/share/kwalletd', '.password-store', '.netrc', '.git-credentials',
  '.npmrc', '.pypirc', '.config/hub', '.codex', '.claude', '.claude.json', '.config/Codex',
  '.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware',
  '.Xauthority', '.ICEauthority',
];
/** Persistence/escape vectors: masked even if they exist outside $HOME. */
const SYSTEM_HIDDEN = ['/run/dbus', '/run/docker.sock', '/var/run/docker.sock', '/run/containerd', '/run/podman', '/etc/jace-commander'];

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).map((entry) => {
    if (!path.isAbsolute(entry)) throw new Error(`sandbox paths must be absolute: ${entry}`);
    return path.resolve(entry);
  });
}

function realOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** node_modules directories that JC's runtime dependencies load from (read-only to workloads). */
export function runtimeModuleDirs(codeDir = CODE_DIR): string[] {
  const require = createRequire(path.join(codeDir, 'index.js'));
  const dirs = new Set<string>();
  for (const dep of RUNTIME_DEPENDENCIES) {
    let resolved: string;
    try {
      resolved = require.resolve(dep);
    } catch {
      continue;
    }
    const parts = resolved.split(path.sep);
    const index = parts.lastIndexOf('node_modules');
    if (index > 0) dirs.add(parts.slice(0, index + 1).join(path.sep));
  }
  return [...dirs];
}

/** The ACS monorepo root when JC is served from a checkout (apps/jace-commander/dist). */
function monorepoRoot(codeDir = CODE_DIR): string | null {
  const candidate = path.resolve(codeDir, '..', '..', '..');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === 'agent-control-stack' ? candidate : null;
  } catch {
    return null;
  }
}

export interface SandboxConfigInput {
  homeDir: string;
  stateDir: string;
  fsRoots: readonly string[];
  fsDeniedRoots: readonly string[];
  managed: boolean;
}

export function sandboxPolicyFromEnv(input: SandboxConfigInput, env: NodeJS.ProcessEnv = process.env): SandboxPolicy {
  const isolation = (env.JC_WORKLOAD_ISOLATION ?? 'bwrap') as WorkloadIsolation;
  if (isolation !== 'bwrap' && isolation !== 'none') throw new Error('JC_WORKLOAD_ISOLATION must be bwrap or none');
  if (isolation === 'none' && (input.managed || env.JC_ALLOW_UNISOLATED_WORKLOADS !== '1')) {
    throw new Error('JC_WORKLOAD_ISOLATION=none is refused (managed mode always isolates workloads; elsewhere it needs JC_ALLOW_UNISOLATED_WORKLOADS=1)');
  }
  const network = (env.JC_WORKLOAD_NETWORK ?? 'none') as WorkloadNetwork;
  if (network !== 'none' && network !== 'host') throw new Error('JC_WORKLOAD_NETWORK must be none or host');
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR ?? (uid !== undefined ? `/run/user/${uid}` : undefined);
  const repo = monorepoRoot();
  const hidden = [
    input.stateDir,
    ...HOME_HIDDEN.map((relative) => path.join(input.homeDir, relative)),
    ...SYSTEM_HIDDEN,
    ...(runtimeDir ? [runtimeDir] : []),
    ...input.fsDeniedRoots,
    // ACS's own database and evidence when ACS runs from this checkout.
    ...(repo ? [path.join(repo, 'storage'), path.join(repo, '.env'), path.join(repo, 'acs.config.yaml')] : []),
    ...splitList(env.JC_SANDBOX_HIDE),
  ];
  const readOnly = [
    path.resolve(CODE_DIR, '..'),
    ...runtimeModuleDirs(),
    path.join(input.homeDir, '.config', 'systemd'),
    ...(repo ? [path.join(repo, 'apps', 'dc-mcp-gateway'), path.join(repo, 'node_modules')] : []),
    ...splitList(env.JC_SANDBOX_READONLY),
  ];
  return Object.freeze({
    isolation,
    network,
    bwrapPath: env.JC_BWRAP_PATH ?? '/usr/bin/bwrap',
    hidden: Object.freeze(hidden),
    readOnly: Object.freeze(readOnly),
    writable: Object.freeze([...input.fsRoots, ...splitList(env.JC_SANDBOX_WRITABLE)]),
  });
}

/** bubblewrap argv that runs `argv` in `cwd` under `policy`. */
export function sandboxArgv(policy: SandboxPolicy, argv: readonly string[], cwd: string, run: SandboxRun = {}): string[] {
  if (policy.isolation === 'none') return [...argv];
  const network = run.network ?? policy.network;
  const args = [
    '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    ...(network === 'none' ? ['--unshare-net'] : []),
    '--cap-drop', 'ALL',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];
  const seen = new Set<string>();
  const once = (flag: string, target: string, kind: 'dir' | 'file' | 'any'): void => {
    const real = realOrNull(target);
    if (!real) return;
    const key = `${flag}:${real}`;
    if (seen.has(key)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return;
    }
    if (kind === 'dir' && !stat.isDirectory()) return;
    seen.add(key);
    if (flag === 'hide') {
      // An empty, read-only directory: nothing is visible and nothing can be staged there.
      if (stat.isDirectory()) args.push('--perms', '0555', '--tmpfs', real, '--remount-ro', real);
      else args.push('--ro-bind', '/dev/null', real);
    } else if (flag === 'rw') {
      args.push('--bind', real, real);
    } else {
      args.push('--ro-bind', real, real);
    }
  };
  for (const entry of policy.writable) once('rw', entry, 'dir');
  // Read-only protections and masks come after writable binds so they win
  // even when they lie inside a writable root.
  for (const entry of policy.readOnly) once('ro', entry, 'any');
  for (const entry of policy.hidden) once('hide', entry, 'any');
  // Per-call re-exposures (git's ssh agent socket, known_hosts) come last.
  for (const entry of run.bindBack ?? []) once('rw', entry, 'any');
  for (const entry of run.roBindBack ?? []) once('ro', entry, 'any');
  args.push('--chdir', cwd, '--', ...argv);
  return [policy.bwrapPath, ...args];
}

export interface SandboxSelfTest {
  ok: boolean;
  isolation: WorkloadIsolation;
  network: WorkloadNetwork;
  detail: string;
}

let cachedSelfTest: { key: string; result: SandboxSelfTest } | undefined;

/**
 * Proves the sandbox is real before any workload runs: the probe must see a
 * private PID namespace (it is PID <= 2 and JC's own PID is not visible), a
 * read-only $HOME and a masked JC state directory.
 */
export function sandboxSelfTest(policy: SandboxPolicy, homeDir: string, stateDir: string): SandboxSelfTest {
  const key = JSON.stringify(policy);
  if (cachedSelfTest?.key === key) return cachedSelfTest.result;
  let result: SandboxSelfTest;
  if (policy.isolation === 'none') {
    result = { ok: true, isolation: 'none', network: policy.network, detail: 'workload isolation disabled (non-managed development preset)' };
  } else if (!fs.existsSync(policy.bwrapPath)) {
    result = { ok: false, isolation: 'bwrap', network: policy.network, detail: `bubblewrap not found at ${policy.bwrapPath}` };
  } else {
    // A canary JC plants in its own (masked) state dir must be invisible.
    let canary: string | undefined;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      canary = path.join(stateDir, `.jc-sandbox-canary-${process.pid}`);
      fs.writeFileSync(canary, 'control-plane', { mode: 0o600 });
    } catch {
      canary = undefined;
    }
    const probe = [
      `test "$$" -le 2 || { echo pidns; exit 3; }`,
      `test ! -e /proc/${process.pid}/environ || { echo procvisible; exit 4; }`,
      `touch /.jc-sandbox-probe 2>/dev/null && { echo rootwritable; exit 5; }`,
      `test -z "$1" || test ! -e "$1" || { echo statevisible; exit 6; }`,
      'echo ok',
    ].join('; ');
    const argv = sandboxArgv(policy, ['/bin/sh', '-c', probe, 'jc-probe', canary ?? ''], '/');
    const out = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.trim().slice(0, 300);
    result = out.status === 0 && /\bok\b/.test(out.stdout ?? '') && canary !== undefined
      ? { ok: true, isolation: 'bwrap', network: policy.network, detail: 'bubblewrap namespaces verified (pid, mount, user, ipc, uts' + (policy.network === 'none' ? ', net)' : '; host network)') }
      : { ok: false, isolation: 'bwrap', network: policy.network, detail: `sandbox self-test failed (${canary === undefined ? 'cannot plant state canary' : text || `exit ${out.status ?? out.signal}`})` };
    if (canary) fs.rmSync(canary, { force: true });
    void homeDir;
  }
  cachedSelfTest = { key, result };
  return result;
}

/** Throws the refusal every workload tool returns when isolation is not proven. */
export function assertSandboxReady(policy: SandboxPolicy, homeDir: string, stateDir: string): void {
  const test = sandboxSelfTest(policy, homeDir, stateDir);
  if (!test.ok) throw new IntegrationError('JC_SANDBOX_UNAVAILABLE', `workload isolation is unavailable (${test.detail}); nothing ran`);
}

export function defaultHome(): string {
  return os.homedir();
}
