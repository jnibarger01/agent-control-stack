import vm from 'node:vm';
import { terminalManager } from '../terminal-manager.js';
import { isProcessAlive } from '../utils/process-identity.js';
import { DcToolError } from './errors.js';
import { recordEvidence } from './context.js';

/**
 * wait_for_process and terminate_process operate ONLY on processes Desktop
 * Commander spawned and tracks (TerminalManager sessions, including sessions
 * recovered from DC's own durable store). Any other pid is refused with
 * DC_PROCESS_NOT_OWNED; these tools never signal or observe arbitrary pids.
 */

export type WaitCondition =
  | { type: 'exit' }
  | { type: 'stdout_pattern' | 'stderr_pattern' | 'either_pattern'; pattern: string };

export interface WaitForProcessInput {
  pid: number;
  timeoutMs?: number;
  until?: { type: string; pattern?: string };
  tailLines?: number;
}

export interface WaitForProcessResult {
  pid: number;
  ownership: 'active' | 'completed' | 'recovered';
  state: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  condition: string;
  matched: { stream: 'stdout' | 'stderr'; text: string; alreadyPresent: boolean } | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const MAX_WAIT_MS = 10 * 60_000;
const MAX_PATTERN = 1_000;

function requirePid(pid: unknown): number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'pid must be a positive integer', { stage: 'validate' });
  }
  return pid;
}

function requireOwned(pid: number) {
  const status = terminalManager.getOwnedSessionStatus(pid);
  if (!status) {
    throw new DcToolError('DC_PROCESS_NOT_OWNED', `pid ${pid} is not a process Desktop Commander spawned and tracks; refusing`, {
      stage: 'validate',
      ruleId: 'dc_owned_sessions_only',
    });
  }
  return status;
}

function parseCondition(until: WaitForProcessInput['until']): { condition: WaitCondition; regex: RegExp | null } {
  if (!until) return { condition: { type: 'exit' }, regex: null };
  if (until.type === 'exit') return { condition: { type: 'exit' }, regex: null };
  if (until.type !== 'stdout_pattern' && until.type !== 'stderr_pattern' && until.type !== 'either_pattern') {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'until.type must be exit, stdout_pattern, stderr_pattern, or either_pattern', { stage: 'validate' });
  }
  if (typeof until.pattern !== 'string' || until.pattern.length === 0 || until.pattern.length > MAX_PATTERN) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `until.pattern is required (1..${MAX_PATTERN} chars) for ${until.type}`, { stage: 'validate' });
  }
  try {
    return { condition: { type: until.type, pattern: until.pattern }, regex: new RegExp(until.pattern, 'm') };
  } catch {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'until.pattern is not a valid regular expression', { stage: 'validate' });
  }
}

/** Per-evaluation budget for a caller-supplied pattern (catastrophic backtracking guard). */
export const PATTERN_EVAL_BUDGET_MS = 100;

class PatternTimeout extends Error {}

/**
 * Runs regex.exec inside a vm context with a hard timeout. V8 interrupts the
 * backtracking engine when the budget is exceeded, so a pattern like (a+)+$
 * can no longer block the event loop (and with it the whole MCP runtime).
 */
function boundedExec(regex: RegExp, text: string): RegExpExecArray | null {
  try {
    return vm.runInNewContext('regex.exec(text)', { regex, text }, { timeout: PATTERN_EVAL_BUDGET_MS }) as RegExpExecArray | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new PatternTimeout();
    throw error;
  }
}

function tail(text: string, lines: number): string {
  // slice(-0) === slice(0) would return everything; zero means "no output".
  if (lines === 0) return '';
  const parts = text.split('\n');
  return parts.slice(-lines - (parts[parts.length - 1] === '' ? 1 : 0)).join('\n');
}

function streamWanted(condition: WaitCondition, stream: 'stdout' | 'stderr'): boolean {
  return condition.type === 'either_pattern'
    || (condition.type === 'stdout_pattern' && stream === 'stdout')
    || (condition.type === 'stderr_pattern' && stream === 'stderr');
}

export async function waitForProcess(input: WaitForProcessInput): Promise<WaitForProcessResult> {
  const pid = requirePid(input.pid);
  const timeoutMs = input.timeoutMs === undefined ? 30_000 : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `timeoutMs must be an integer between 0 and ${MAX_WAIT_MS}`, { stage: 'validate' });
  }
  const tailLines = input.tailLines === undefined ? 50 : input.tailLines;
  if (!Number.isInteger(tailLines) || tailLines < 0 || tailLines > 1_000) {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'tailLines must be an integer between 0 and 1000', { stage: 'validate' });
  }
  const { condition, regex } = parseCondition(input.until);
  const initial = requireOwned(pid);
  if (initial.ownership === 'recovered' && condition.type !== 'exit') {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'recovered sessions have no attached output streams; only until.type=exit is supported', { stage: 'validate' });
  }

  const started = Date.now();
  let matched: WaitForProcessResult['matched'] = null;
  let timedOut = false;
  let patternTimedOut = false;

  await new Promise<void>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      terminalManager.sessionEvents.off('output', onOutput);
      terminalManager.sessionEvents.off('exit', onExit);
      resolve();
    };
    const onOutput = (eventPid: number, stream: 'stdout' | 'stderr') => {
      if (eventPid !== pid || !regex || !streamWanted(condition, stream)) return;
      const state = terminalManager.getStreamState(pid);
      const text = stream === 'stdout' ? state?.stdoutTail ?? '' : state?.stderrTail ?? '';
      let m: RegExpExecArray | null;
      try {
        m = boundedExec(regex, text);
      } catch {
        patternTimedOut = true;
        finish();
        return;
      }
      if (m) {
        matched = { stream, text: m[0].slice(0, 200), alreadyPresent: false };
        finish();
      }
    };
    const onExit = (eventPid: number) => {
      if (eventPid === pid) finish();
    };
    // Subscribe BEFORE inspecting current state so no event is missed.
    terminalManager.sessionEvents.on('output', onOutput);
    terminalManager.sessionEvents.on('exit', onExit);

    const state = terminalManager.getStreamState(pid);
    if (regex && state) {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (!streamWanted(condition, stream)) continue;
        let m: RegExpExecArray | null;
        try {
          m = boundedExec(regex, stream === 'stdout' ? state.stdoutTail : state.stderrTail);
        } catch {
          patternTimedOut = true;
          finish();
          return;
        }
        if (m) {
          matched = { stream, text: m[0].slice(0, 200), alreadyPresent: true };
          finish();
          return;
        }
      }
    }
    const now = terminalManager.getOwnedSessionStatus(pid);
    if (!now || now.exited) {
      finish();
      return;
    }
    if (initial.ownership === 'recovered') {
      poller = setInterval(() => {
        if (!isProcessAlive(pid)) finish();
      }, 250);
    }
    timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);
  });

  if (patternTimedOut) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `until.pattern exceeded its ${PATTERN_EVAL_BUDGET_MS}ms evaluation budget (catastrophic backtracking); use a simpler pattern`, { stage: 'execute', ruleId: 'wait_for_process.pattern_budget' });
  }
  const final = terminalManager.getOwnedSessionStatus(pid);
  const streams = terminalManager.getStreamState(pid);
  const exited = final ? final.exited : (initial.ownership === 'recovered' ? !isProcessAlive(pid) : true);
  const result: WaitForProcessResult = {
    pid,
    ownership: final?.ownership ?? initial.ownership,
    state: exited ? 'exited' : 'running',
    exitCode: final?.exitCode ?? streams?.exitCode ?? null,
    signal: final?.exitSignal ?? streams?.exitSignal ?? null,
    condition: condition.type,
    matched,
    timedOut,
    durationMs: Date.now() - started,
    stdoutTail: tail(streams?.stdoutTail ?? '', tailLines),
    stderrTail: tail(streams?.stderrTail ?? '', tailLines),
  };
  recordEvidence({ exitCode: result.exitCode, signal: result.signal, results: { state: result.state, timedOut, matched: matched !== null } });
  return result;
}

export interface TerminateProcessInput {
  pid: number;
  graceMs?: number;
  force?: boolean;
}

export interface TerminateProcessResult {
  pid: number;
  ownership: 'active' | 'completed' | 'recovered';
  alreadyExited: boolean;
  signalsSent: string[];
  escalated: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

function waitForExit(pid: number, ms: number, recovered: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const status = terminalManager.getOwnedSessionStatus(pid);
    if (status?.exited || (recovered && !isProcessAlive(pid))) return resolve(true);
    let poller: NodeJS.Timeout | undefined;
    const onExit = (eventPid: number) => {
      if (eventPid === pid) done(true);
    };
    const timer = setTimeout(() => done(recovered ? !isProcessAlive(pid) : false), ms);
    function done(value: boolean) {
      clearTimeout(timer);
      if (poller) clearInterval(poller);
      terminalManager.sessionEvents.off('exit', onExit);
      resolve(value);
    }
    terminalManager.sessionEvents.on('exit', onExit);
    if (recovered) poller = setInterval(() => { if (!isProcessAlive(pid)) done(true); }, 100);
  });
}

export async function terminateOwnedProcess(input: TerminateProcessInput): Promise<TerminateProcessResult> {
  const pid = requirePid(input.pid);
  const graceMs = input.graceMs === undefined ? 3_000 : input.graceMs;
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'graceMs must be an integer between 0 and 30000', { stage: 'validate' });
  }
  const force = input.force ?? true;
  const status = requireOwned(pid);
  const started = Date.now();
  if (status.exited) {
    return { pid, ownership: status.ownership, alreadyExited: true, signalsSent: [], escalated: false, exited: true, exitCode: status.exitCode, signal: status.exitSignal, durationMs: 0 };
  }
  const recovered = status.ownership === 'recovered';
  if (recovered && !(await terminalManager.refreshRecoveredSessionLiveness(pid))) {
    // Identity no longer matches (pid reuse) or it is gone: never signal it.
    throw new DcToolError('DC_PROCESS_NOT_FOUND', `recovered session ${pid} is no longer the process DC started; not signalling`, { stage: 'validate', ruleId: 'process_identity' });
  }
  const signalsSent: string[] = [];
  if (!terminalManager.signalOwnedSession(pid, 'SIGTERM')) {
    throw new DcToolError('DC_PROCESS_NOT_OWNED', `pid ${pid} is not a running DC-owned session`, { stage: 'execute' });
  }
  signalsSent.push('SIGTERM');
  let exited = await waitForExit(pid, graceMs, recovered);
  let escalated = false;
  if (!exited && force && terminalManager.signalOwnedSession(pid, 'SIGKILL')) {
    signalsSent.push('SIGKILL');
    escalated = true;
    exited = await waitForExit(pid, 5_000, recovered);
  }
  const final = terminalManager.getOwnedSessionStatus(pid);
  const result: TerminateProcessResult = {
    pid,
    ownership: status.ownership,
    alreadyExited: false,
    signalsSent,
    escalated,
    exited,
    exitCode: final?.exitCode ?? null,
    signal: final?.exitSignal ?? null,
    durationMs: Date.now() - started,
  };
  recordEvidence({ exitCode: result.exitCode, signal: result.signal, results: { signalsSent, escalated, exited } });
  return result;
}
