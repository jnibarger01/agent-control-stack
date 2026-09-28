/**
 * Read-only diagnosis of this JC process. It does not change bridge config
 * and it does not print secrets.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JcConfig } from './config.js';
import { JC_MANIFEST } from './manifest.generated.js';
import { VERSION } from '../version.js';

const exec = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function probe(url: string | undefined): Promise<DoctorCheck> {
  if (!url) return { name: 'acs', ok: false, detail: 'JC_ACS_URL is not configured' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { name: 'acs', ok: response.ok, detail: `${url} -> ${response.status}` };
  } catch (error) {
    return { name: 'acs', ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
  }
}

export async function jcDoctor(config: JcConfig): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: 'cli', ok: true, detail: `jace-commander ${VERSION}` });
  checks.push({
    name: 'manifest',
    ok: JC_MANIFEST.tools.length >= 30,
    detail: `${JC_MANIFEST.tools.length} tools, hash ${JC_MANIFEST.manifestHash.slice(0, 12)}`,
  });
  checks.push({
    name: 'filesystem roots',
    ok: config.fsRoots.length > 0,
    detail: config.fsRoots.length ? config.fsRoots.join(',') : 'JC_FS_ROOTS empty; filesystem tools fail closed',
  });
  checks.push({
    name: 'runtime',
    ok: Boolean(config.runtimeId),
    detail: `runtime ${config.runtimeId}; state ${config.stateDir}`,
  });
  const cwd = process.cwd();
  const legacy = cwd.includes(`${path.sep}projects${path.sep}desktop-commander`) && !cwd.includes(`${path.sep}vendor${path.sep}desktop-commander`);
  checks.push({
    name: 'bridge path',
    ok: !legacy,
    detail: legacy
      ? `process cwd looks like a legacy desktop-commander checkout (${cwd}); JC should run from vendor/desktop-commander`
      : `cwd ${cwd}`,
  });
  checks.push(await probe(config.acsUrl ? `${config.acsUrl.replace(/\/$/, '')}/health` : undefined));
  try {
    const version = (await exec('git', ['--version'], { timeout: 2000 })).stdout.trim();
    checks.push({ name: 'git', ok: true, detail: version });
  } catch {
    checks.push({ name: 'git', ok: false, detail: 'git is not executable' });
  }
  return {
    ok: checks.every((check) => check.ok || check.name === 'acs'),
    version: VERSION,
    toolCount: JC_MANIFEST.tools.length,
    manifestHash: JC_MANIFEST.manifestHash,
    checks,
  };
}

export async function jcPing(config: JcConfig): Promise<Record<string, unknown>> {
  const acs = await probe(config.acsUrl ? `${config.acsUrl.replace(/\/$/, '')}/health` : undefined);
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
