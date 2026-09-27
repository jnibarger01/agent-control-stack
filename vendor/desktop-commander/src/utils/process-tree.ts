import { spawn } from 'child_process';

/**
 * Shared process-lifecycle primitive: terminate a process and its full
 * descendant tree, not just the single PID we spawned.
 *
 * Without this, killing only the direct child leaves orphans behind
 * whenever that child spawns processes of its own (a shell running a
 * pipeline, a wrapper script, a REPL that forks workers) — the tracked
 * session disappears but its descendants keep running unmanaged and
 * unkillable through this server.
 *
 * Requires the target to have been spawned with `detached: true` on POSIX
 * platforms (making it the leader of its own process group) — see
 * spawnDetachedOnPosix(). Signaling the negative PID then reaches the
 * whole group in one syscall. Windows has no equivalent to POSIX process
 * groups for this purpose; `taskkill /T` walks the actual parent-child
 * tree instead, which works regardless of how the process was spawned.
 * Windows also has no signal distinction the way POSIX does — SIGINT and
 * SIGKILL both resolve to the same forceful taskkill there, matching how
 * Node itself emulates POSIX signals on Windows.
 */
export function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32') {
      // Negative pid targets the whole process group of the group leader `pid`.
      process.kill(-pid, signal);
    } else {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        // taskkill itself failed to launch (missing/blocked) — fall back to
        // signaling just the one process rather than leaving it fully unmanaged.
        try {
          process.kill(pid, signal);
        } catch {
          // Process may have already exited.
        }
      });
    }
  } catch {
    // Process (or its whole group) may have already exited between the
    // liveness check and this call — nothing left to terminate.
  }
}

/**
 * Whether child processes spawned by this server should be made the leader
 * of their own process group (POSIX only — Windows has no equivalent and
 * taskkill /T does not need it). Centralized so every spawn site that wants
 * terminateProcessTree() to reach descendants configures it the same way.
 */
export function shouldSpawnAsProcessGroupLeader(): boolean {
  return process.platform !== 'win32';
}
