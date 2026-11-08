/**
 * Unprivileged side of privileged_exec: forwards {capability, arguments} to
 * the root helper through `sudo -n` and returns its JSON verdict. It makes no
 * authorization decision of its own — the helper re-verifies everything.
 */
import { spawn } from 'node:child_process';
import { HARD_MAX_TIMEOUT_MS } from './privileged-core.js';

export interface PrivilegedClientOptions {
  sudoPath: string;
  helperPath: string;
}

const MAX_HELPER_OUTPUT = 4 * 1024 * 1024;

export function invokePrivilegedHelper(
  request: { capability: unknown; arguments: unknown },
  options: PrivilegedClientOptions,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    // `-n`: never prompt. Without the pinned NOPASSWD rule this fails fast
    // instead of hanging on a password prompt no agent can answer.
    const child = spawn(options.sudoPath, ['-n', '--', options.helperPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HELPER_OUTPUT) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    // Helper enforces the command timeout; this is only a backstop.
    const backstop = setTimeout(() => child.kill('SIGKILL'), HARD_MAX_TIMEOUT_MS + 15_000);
    child.on('error', () => {
      clearTimeout(backstop);
      resolve({ ok: false, code: 'PRIVILEGED_HELPER_UNAVAILABLE' });
    });
    child.on('close', () => {
      clearTimeout(backstop);
      if (overflow) return resolve({ ok: false, code: 'PRIVILEGED_HELPER_OUTPUT_TOO_LARGE' });
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return resolve(parsed);
      } catch {
        // fall through
      }
      // Typically sudo refusing (no sudoers rule / helper not installed).
      resolve({ ok: false, code: 'PRIVILEGED_HELPER_UNAVAILABLE' });
    });
    child.stdin.on('error', () => { /* surfaced via close */ });
    child.stdin.end(JSON.stringify(request));
  });
}

/** True only if sudo will run the helper non-interactively (`sudo -n -l <helper>`). */
export function privilegedHelperAvailable(options: PrivilegedClientOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(options.sudoPath, ['-n', '-l', '--', options.helperPath], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
