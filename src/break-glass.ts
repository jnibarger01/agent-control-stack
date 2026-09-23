/**
 * Break-glass mutual exclusion (hardening item #1).
 *
 * The UNMANAGED/BREAK_GLASS fallback (/home/jacen/bin/desktop-commander-remote,
 * launched by desktop-commander-remote.service) runs the stock upstream
 * @wonderwhy-er/desktop-commander package outside ACS authority: no capability
 * verification, lease/fencing, gateway attestation, or receipts apply to it.
 *
 * While it is active, the shell wrapper writes a marker file at
 * ~/.desktop-commander/break-glass.lock (same directory as executor.lock, same
 * JSON-lease shape: {pid, acquiredAt, mode, hostname}). This module lets the
 * managed executor refuse to start while that marker shows a live PID, giving
 * bidirectional mutual exclusion: the wrapper already refuses to start while
 * executor.lock shows a live managed PID (see the wrapper script itself).
 *
 * Ambiguous state (marker present but unreadable/malformed) fails closed:
 * treated as an active break-glass session, never as "safe to proceed".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isPidAlive } from './executor-lock.js';

export interface BreakGlassInfo {
  pid: number;
  acquiredAt: number;
  mode: string;
  hostname: string;
}

export interface BreakGlassStatus {
  active: boolean;
  ambiguous: boolean;
  info?: BreakGlassInfo;
  detail: string;
}

function defaultStateDir(): string {
  const override = process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), '.desktop-commander');
}

export function breakGlassMarkerPath(stateDir?: string): string {
  return path.join(stateDir ?? defaultStateDir(), 'break-glass.lock');
}

/**
 * Read and classify the break-glass marker. Fail closed: a present-but-
 * unparsable marker is reported as active/ambiguous, never as inactive.
 */
export function checkBreakGlassStatus(stateDir?: string): BreakGlassStatus {
  const markerPath = breakGlassMarkerPath(stateDir);
  if (!fs.existsSync(markerPath)) {
    return { active: false, ambiguous: false, detail: 'no break-glass marker present' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return { active: true, ambiguous: true, detail: `break-glass marker present but unreadable: ${markerPath}` };
  }
  const info = parsed as Partial<BreakGlassInfo>;
  if (typeof info.pid !== 'number') {
    return { active: true, ambiguous: true, detail: `break-glass marker malformed (no pid): ${markerPath}` };
  }
  const alive = isPidAlive(info.pid);
  if (!alive) {
    return { active: false, ambiguous: false, detail: `break-glass marker stale (pid ${info.pid} not alive)` };
  }
  return {
    active: true,
    ambiguous: false,
    info: info as BreakGlassInfo,
    detail: `break-glass session active (pid ${info.pid})`,
  };
}
