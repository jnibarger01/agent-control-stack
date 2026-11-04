#!/usr/bin/env node
/**
 * jc-privileged-helper — the ONLY sudo entrypoint for Jace Commander.
 *
 * Installed root-owned and reached through a single pinned sudoers rule that
 * permits exactly this program with no arguments (deploy/jace-commander/
 * sudoers.jace-commander). Protocol: one JSON request on stdin
 * `{capability, arguments}`, one JSON result on stdout. Exit 0 = the command
 * ran (its own exit code is in the result), exit 2 = rejected, nothing ran.
 *
 * Configuration is read only from the root-owned DEFAULT_PRIVILEGED_CONFIG_PATH
 * when running as root. Environment overrides are honoured only when NOT root
 * (local development/tests), and sudo's env_reset strips them anyway.
 */
import {
  DEFAULT_PRIVILEGED_CONFIG_PATH,
  MAX_REQUEST_BYTES,
  PrivilegedError,
  executePrivileged,
  loadPrivilegedConfig,
} from './privileged-core.js';

function readStdin(limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PrivilegedError('PRIVILEGED_REQUEST_INVALID', 'request too large'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function emit(result: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
  if (!isRoot && process.env.JC_PRIVILEGED_ALLOW_NONROOT !== '1') {
    emit({ ok: false, code: 'PRIVILEGED_NOT_ROOT' }, 2);
  }
  const configPath = isRoot ? DEFAULT_PRIVILEGED_CONFIG_PATH : (process.env.JC_PRIVILEGED_CONFIG ?? DEFAULT_PRIVILEGED_CONFIG_PATH);
  let config;
  try {
    config = loadPrivilegedConfig(configPath, isRoot);
  } catch (error) {
    emit({ ok: false, code: error instanceof PrivilegedError ? error.code : 'PRIVILEGED_CONFIG_INVALID' }, 2);
  }
  let request: unknown;
  try {
    request = JSON.parse(await readStdin(MAX_REQUEST_BYTES));
  } catch {
    emit({ ok: false, code: 'PRIVILEGED_REQUEST_INVALID' }, 2);
  }
  const result = await executePrivileged(request, config);
  emit(result, result.ok ? 0 : 2);
}

main().catch(() => emit({ ok: false, code: 'PRIVILEGED_INTERNAL_ERROR' }, 2));
