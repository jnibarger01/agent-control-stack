/**
 * Local-preset dependency probe for the JC bridge.
 *
 * `/ready` must not mean "the HTTP listener answered". For the local preset it
 * also has to prove the things a governed call actually depends on:
 *
 *   - the pinned installed release can load its policy; and
 *   - bubblewrap isolation really works for the account that will run
 *     workloads.
 *
 * The bridge does not re-implement JC's policy or sandbox code. It runs the
 * pinned release's own `local-readiness --json` verb through the same
 * DC_CMD/DC_ARGS wrapper (the setpriv/runuser uid drop) and CHILD_ENV allowlist
 * used for the executor. The result is cached and never run concurrently, so a
 * readiness poll does not spawn a process storm.
 *
 * The probe is a dependency check, not the enforcement boundary: every
 * workload still calls assertSandboxReady() in the child and refuses to run if
 * isolation is unavailable.
 */
import { spawn } from 'node:child_process';

const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 4 * 1024;

/** The same wrapper prefix, but the release's readiness verb instead of `serve`. */
export function localReadinessInvocation({ cmd, args }) {
  if (typeof cmd !== 'string' || !cmd) return null;
  if (!Array.isArray(args) || args.length === 0) return null;
  const entry = args.findIndex(
    (arg) => typeof arg === 'string' && /(?:^|[\\/])dist[\\/]cli\.js$/u.test(arg)
  );
  if (entry < 0) return null;
  return { command: cmd, args: [...args.slice(0, entry + 1), 'local-readiness', '--json'] };
}

/**
 * Create a cached probe. `status()` is synchronous and safe for the HTTP
 * handler; `start()` refreshes immediately and then on an interval.
 */
export function createLocalReadinessProbe({
  command,
  args,
  cwd,
  env,
  intervalMs = 30_000,
  timeoutMs = 15_000,
  spawnImpl = spawn,
  now = () => new Date().toISOString()
}) {
  let state = {
    status: 'pending',
    ok: false,
    detail: 'local readiness probe has not completed'
  };
  let inFlight = null;
  let timer = null;

  function failed(detail) {
    state = { status: 'failed', ok: false, checkedAt: now(), detail };
  }

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child;
      let killTimer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        state = result;
        inFlight = null;
        resolve(result);
      };
      try {
        child = spawnImpl(command, args, {
          cwd,
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        failed(`local readiness probe could not start: ${error?.message || 'error'}`);
        finish(state);
        return;
      }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMs);
      killTimer.unref?.();
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        failed(`local readiness probe failed to run: ${error?.message || 'error'}`);
        finish(state);
      });
      child.on('close', (code, signal) => {
        const text = stdout.trim();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const ok = parsed.ok === true;
              const detail = ok
                ? parsed.sandbox?.detail || 'local policy and workload sandbox verified'
                : parsed.policy?.state === 'invalid'
                  ? `local policy is invalid: ${(parsed.policy?.errors || []).join('; ') || 'unusable'}`
                  : parsed.sandbox?.detail || 'local readiness probe reported not ok';
              finish({
                status: ok ? 'ok' : 'failed',
                checkedAt: now(),
                ...parsed,
                ok,
                detail
              });
              return;
            }
          } catch {
            // fall through to a diagnostic built from the exit state
          }
        }
        const reason = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
        failed(
          `local readiness probe exited ${code ?? signal ?? 'unknown'}`
            + (reason ? `: ${reason.slice(0, 500)}` : '')
        );
        finish(state);
      });
    });
    return inFlight;
  }

  return {
    refresh,
    start() {
      void refresh();
      if (timer) return;
      timer = setInterval(() => { void refresh(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return state;
    }
  };
}
