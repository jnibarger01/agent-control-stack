/**
 * Read-only diagnosis of this JC process: what it serves, what authority it
 * verifies against, where its code actually runs from, and which backends it
 * can reach. It does not change bridge config and it does not print secrets.
 * The CLI's `doctor` adds the client-side half (endpoint + live tools/list).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { JcConfig } from './config.js';
import { acsReadyUrl } from './integrations.js';
import { JC_MANIFEST } from './manifest.generated.js';
import { VERSION } from '../version.js';

const exec = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** A failed required check makes the whole report fail. */
  required: boolean;
  detail: string;
}

export interface DoctorRuntime {
  mode: 'managed' | 'standalone' | 'local';
  handlerNames: readonly string[];
  verifierReady: boolean;
  /** Present for the `local` preset. */
  policy?: import('./local-policy.js').JcPolicyLoad;
  /** Present for the `local` preset. */
  approver?: () => Promise<Record<string, unknown>>;
  privilegedHelper: () => Promise<boolean>;
}

const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function probe(url: string | undefined): Promise<DoctorCheck> {
  if (!url) return { name: 'acs', ok: false, required: false, detail: 'JC_ACS_URL is not configured' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { name: 'acs', ok: response.ok, required: false, detail: `${url} -> HTTP ${response.status}` };
  } catch (error) {
    return { name: 'acs', ok: false, required: false, detail: `${url} unreachable: ${error instanceof Error ? error.message : 'error'}` };
  }
}

/** Where this code runs from. The JC bridge must launch vendor/desktop-commander. */
export function bridgePathCheck(codeDir = CODE_DIR): DoctorCheck {
  const vendored = codeDir.split(path.sep).join('/').includes('/vendor/desktop-commander/');
  return {
    name: 'bridge path',
    ok: vendored,
    required: true,
    detail: vendored
      ? `serving from ${codeDir}`
      : `serving from ${codeDir}, not the monorepo vendor/desktop-commander; the bridge is launching a legacy checkout`,
  };
}

async function releaseIdentity(): Promise<{ sha: string | null; source: string }> {
  const fromEnv = process.env.JC_RELEASE_SHA;
  if (fromEnv && /^[a-f0-9]{40}$/u.test(fromEnv)) return { sha: fromEnv, source: 'JC_RELEASE_SHA' };
  try {
    const sha = (await exec('git', ['-C', CODE_DIR, 'rev-parse', 'HEAD'], { timeout: 2000 })).stdout.trim();
    if (/^[a-f0-9]{40}$/u.test(sha)) return { sha, source: 'git checkout of the served code' };
  } catch {
    // Not a checkout (e.g. a release directory without JC_RELEASE_SHA).
  }
  return { sha: null, source: 'unknown' };
}

export async function jcDoctor(config: JcConfig, runtime: DoctorRuntime): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];
  const manifestNames = JC_MANIFEST.tools.map((tool) => tool.name).sort();
  const handlerNames = [...runtime.handlerNames].sort();
  const missing = manifestNames.filter((name) => !handlerNames.includes(name));
  const extra = handlerNames.filter((name) => !manifestNames.includes(name));
  checks.push({
    name: 'manifest',
    ok: missing.length === 0 && extra.length === 0,
    required: true,
    detail: `${manifestNames.length} manifest tools, ${handlerNames.length} live handlers, hash ${JC_MANIFEST.manifestHash.slice(0, 12)}`
      + (missing.length ? `; no handler: ${missing.join(',')}` : '')
      + (extra.length ? `; not in manifest: ${extra.join(',')}` : ''),
  });
  checks.push({
    name: 'capability verification',
    ok: runtime.mode === 'managed' ? runtime.verifierReady : runtime.mode === 'local',
    required: true,
    detail: runtime.mode === 'managed'
      ? runtime.verifierReady
        ? `managed: every call needs an ACS-issued acs.jc.v1 capability (key ${config.acsKeyId ?? 'unset'})`
        : 'managed but no ACS verification key is configured; every call fails closed'
      : runtime.mode === 'local'
        ? 'local: read class allowed; other classes follow the local class decisions (default: human approval)'
        : 'standalone: read-only tools only, NOT capability-checked; development only',
  });
  if (runtime.policy) {
    const policy = runtime.policy;
    const loosened = Object.entries(policy.effective.classDecisions).filter(([cls, decision]) => cls !== 'read' && decision === 'allow').map(([cls]) => cls);
    checks.push({
      name: 'local policy',
      ok: policy.state !== 'invalid' && !policy.unsafeDev && policy.immutable,
      required: true,
      detail: policy.state === 'invalid'
        ? `INVALID, everything except jc.meta is denied: ${policy.errors.join('; ')}`
        : policy.unsafeDev
          ? 'JC_POLICY_UNSAFE_DEV=1: a policy this process can edit is accepted; development only'
          : `${policy.state} (hash ${policy.hash.slice(0, 12)}${policy.sources.length ? `, ${policy.sources.join(' + ')}` : ''})`
            + (loosened.length ? `; classes allowed without approval: ${loosened.join(', ')} (guardrails, not a sandbox: rely on the OS account and unit hardening)` : ''),
    });
  }
  if (runtime.approver && runtime.policy) {
    const health = await runtime.approver();
    const needed = Object.values(runtime.policy.effective.classDecisions).includes('approve');
    const separated = health.serverCanDecide !== true;
    checks.push({
      name: 'local approver',
      ok: health.configured === true && health.reachable === true && health.keyMatches === true && separated,
      // Only an error when the policy actually sends calls to a human.
      required: needed,
      detail: !health.configured
        ? 'approverd is not configured (JC_APPROVER_SOCKET, JC_APPROVER_PUBLIC_KEY, JC_APPROVER_KEY_ID); approve-class calls fail closed'
        : !health.reachable
          ? 'approverd is configured but not reachable; approve-class calls fail closed'
          : !health.keyMatches
            ? 'approverd answered with a different key id or runtime id than configured'
            : !separated
              ? 'THE SERVER IDENTITY CAN OPEN decide.sock: the model could approve its own requests; fix socket group/permissions'
              : 'approverd reachable, key matches, decide.sock is not reachable by the server identity',
    });
  }
  const roots = config.fsRoots.map((root) => ({ root, exists: fs.existsSync(root) }));
  checks.push({
    name: 'filesystem roots',
    ok: roots.length > 0 && roots.every((root) => root.exists),
    required: false,
    detail: roots.length
      ? roots.map((root) => `${root.root}${root.exists ? '' : ' (missing)'}`).join(', ')
      : 'JC_FS_ROOTS empty; filesystem, process and git tools fail closed',
  });
  checks.push(bridgePathCheck());
  checks.push(await probe(config.acsUrl ? acsReadyUrl(config) : undefined));
  try {
    const version = (await exec('git', ['--version'], { timeout: 2000 })).stdout.trim();
    checks.push({ name: 'git backend', ok: true, required: false, detail: version });
  } catch {
    checks.push({ name: 'git backend', ok: false, required: false, detail: 'git is not executable; git tools will fail' });
  }
  checks.push({
    name: 'process backend',
    ok: true,
    required: false,
    detail: `node ${process.version} (${process.execPath}); argv-only spawn, allowlisted env`,
  });
  const helper = await runtime.privilegedHelper().catch(() => false);
  checks.push({
    name: 'privileged helper',
    ok: helper,
    required: false,
    detail: helper ? `${config.privilegedHelperPath} via sudo -n` : 'not installed or sudo -n refused; privileged_exec will fail',
  });
  const release = await releaseIdentity();
  checks.push({
    name: 'release identity',
    ok: release.sha !== null,
    required: false,
    detail: release.sha ? `${release.sha} (${release.source})` : 'unknown; set JC_RELEASE_SHA for release directories',
  });
  return {
    ok: checks.every((check) => check.ok || !check.required),
    version: VERSION,
    releaseSha: release.sha,
    mode: runtime.mode,
    toolCount: JC_MANIFEST.tools.length,
    liveHandlerCount: handlerNames.length,
    manifestHash: JC_MANIFEST.manifestHash,
    checks,
  };
}

export async function jcPing(config: JcConfig): Promise<Record<string, unknown>> {
  const acs = await probe(config.acsUrl ? acsReadyUrl(config) : undefined);
  return { ok: true, version: VERSION, time: new Date().toISOString(), acs };
}

export function jcConfigView(config: JcConfig): Record<string, unknown> {
  return {
    version: VERSION,
    runtimeId: config.runtimeId,
    acsUrl: config.acsUrl,
    publicMcpUrl: config.publicMcpUrl,
    swarmUrl: config.swarmUrl,
    visualizerUrl: config.visualizerUrl ?? null,
    fsRoots: config.fsRoots,
    toolCount: JC_MANIFEST.tools.length,
    manifestHash: JC_MANIFEST.manifestHash,
  };
}
