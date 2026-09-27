import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { configManager } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState } from './utils/process-detection.js';
import { terminateProcessTree, shouldSpawnAsProcessGroupLeader } from './utils/process-tree.js';
import { newSessionId, writeSessionRecord, readSessionRecord, sessionSchemaVersion, PersistedSessionRecord } from './session-store.js';
import { getProcessStartFingerprint, verifyProcessIdentity } from './utils/process-identity.js';
import { getRuntimeIdentityState } from './runtime-identity.js';
import type { RecoveredSessionHandle } from './session-reconciliation.js';
import { logger } from './utils/logger.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       // Line-based buffer (consistent with active sessions)
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  evictedLines: number;        // Carried over from the active session (see TerminalSession)
  evictedChars: number;
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  // per session; oldest lines evicted first
const MAX_LINE_CHARS = 1024 * 1024;                  // force-split longer lines so eviction can work
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       // start_process wait buffer (prompt/state detection)

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  
  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // PowerShell Core (cross-platform, supports -Login)
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    return { 
      executable: shellPath, 
      args: ['-Login', '-Command', command],
      useShellOption: false 
    };
  }
  
  // Windows PowerShell 5.1 (no login flag support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    return { 
      executable: shellPath, 
      args: ['-Command', command],
      useShellOption: false 
    };
  }
  
  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return { 
      executable: shellPath, 
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false 
    };
  }
  
  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return { 
    executable: command,
    args: [],
    useShellOption: shellPath 
  };
}

/** Per-stream tail retained for each DC-spawned session (bounded). */
export const STREAM_TAIL_MAX_CHARS = 64 * 1024;

export interface SessionStreamState {
  stdoutTail: string;
  stderrTail: string;
  stdoutChars: number;
  stderrChars: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  endTime?: Date;
}

export interface OwnedSessionStatus {
  pid: number;
  ownership: 'active' | 'completed' | 'recovered';
  sessionId?: string;
  startTime?: Date;
  endTime?: Date;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

export class TerminalManager {
  /**
   * Emits 'output' (pid, stream, text) and 'exit' (pid, code, signal) for
   * DC-spawned sessions, so callers can wait without polling
   * (wait_for_process). Listeners must not throw.
   */
  readonly sessionEvents = new EventEmitter().setMaxListeners(200);
  private streamState: Map<number, SessionStreamState> = new Map();
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  // Sessions recovered from a durable record after a server restart (P2.1).
  // Keyed by pid, disjoint from `sessions`: a recovered entry has no
  // ChildProcess handle (the original spawning process is gone), only
  // enough to check liveness and terminate via the shared process-tree
  // utility — see registerRecoveredSession, forceTerminate, listActiveSessions.
  private recoveredSessions: Map<number, RecoveredSessionHandle> = new Map();

  /**
   * Registers a session recovered by startup reconciliation
   * (session-reconciliation.ts) as live-but-not-attached. Idempotent: a
   * pid already present is left as-is rather than overwritten, so running
   * reconciliation more than once never duplicates or resets tracking.
   */
  registerRecoveredSession(handle: RecoveredSessionHandle): void {
    if (this.recoveredSessions.has(handle.pid)) return;
    if (this.sessions.has(handle.pid)) return; // a live, attached session already owns this pid
    this.recoveredSessions.set(handle.pid, handle);
  }

  isRecoveredSession(pid: number): boolean {
    return this.recoveredSessions.has(pid);
  }

  getRecoveredSession(pid: number): RecoveredSessionHandle | undefined {
    return this.recoveredSessions.get(pid);
  }

  /**
   * A recovered session has no ChildProcess handle, so there is no 'exit'
   * event to tell us when it dies — unlike a live session, which the OS
   * proactively notifies this server about. Callers that act on a recovered
   * session re-verify liveness on demand instead; this both answers the
   * question and — if the process is gone — cleans it up (removes it from
   * the tracked map, marks its durable record 'stale') so a single stale
   * entry doesn't linger as "recovered" forever.
   */
  async refreshRecoveredSessionLiveness(pid: number): Promise<boolean> {
    const handle = this.recoveredSessions.get(pid);
    if (!handle) return false;

    const record = await readSessionRecord(handle.sessionId);
    const identity = await verifyProcessIdentity(pid, record?.processStartFingerprint);

    if (identity === 'alive') return true;

    this.recoveredSessions.delete(pid);
    if (record) {
      try {
        await writeSessionRecord({
          ...record,
          status: 'stale',
          staleReason: identity === 'reused' ? 'pid reused by a different process since recovery' : 'process no longer exists',
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.warning(`Desktop Commander: failed to persist stale transition for recovered pid ${pid}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return false;
  }

  private async persistNewSession(
    session: TerminalSession,
    command: string,
    cwd: string | undefined,
    shell: string,
  ): Promise<void> {
    try {
      const identity = await getRuntimeIdentityState();
      const fingerprint = await getProcessStartFingerprint(session.pid);
      const now = new Date().toISOString();
      const record: PersistedSessionRecord = {
        schemaVersion: sessionSchemaVersion() as 1,
        sessionId: session.sessionId,
        pid: session.pid,
        processStartFingerprint: fingerprint,
        command,
        cwd,
        shell,
        ownerRuntimeId: identity.runtime_id,
        createdAt: now,
        updatedAt: now,
        status: 'running',
      };
      await writeSessionRecord(record);
    } catch (error) {
      // Durability is best-effort: a failure here degrades recovery for
      // this one session after a future restart, but must never prevent
      // the process itself from running.
      logger.warning(`Desktop Commander: failed to persist session record for pid ${session.pid}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistSessionExit(
    sessionId: string,
    exitCode: number | null,
    exitSignal: string | null,
  ): Promise<void> {
    try {
      const existing = await readSessionRecord(sessionId);
      if (!existing) return; // never persisted (e.g. persistNewSession itself failed) — nothing to update
      const updated: PersistedSessionRecord = {
        ...existing,
        status: exitSignal ? 'terminated' : 'completed',
        exitCode,
        exitSignal,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeSessionRecord(updated);
    } catch (error) {
      logger.warning(`Desktop Commander: failed to persist session exit for session ${sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Marks a recovered session's durable record terminated, after forceTerminate. */
  private async persistRecoveredSessionTerminated(handle: RecoveredSessionHandle): Promise<void> {
    try {
      const existing = await readSessionRecord(handle.sessionId);
      if (!existing) return;
      await writeSessionRecord({
        ...existing,
        status: 'terminated',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warning(`Desktop Commander: failed to persist recovered-session termination for pid ${handle.pid}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }
    
    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        // Ensure input ends with a newline for most REPLs
        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        session.process.stdin.write(inputWithNewline);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string, collectTiming: boolean = false, cwd?: string): Promise<CommandExecutionResult> {
    // Get the shell from config if not specified
    let shellToUse: string | boolean | undefined = shell;
    if (!shellToUse) {
      try {
        const config = await configManager.getConfig();
        shellToUse = config.defaultShell || true;
      } catch (error) {
        // If there's an error getting the config, fall back to default
        shellToUse = true;
      }
    }

    // For REPL interactions, we need to ensure stdin, stdout, and stderr are properly configured
    // Note: No special stdio options needed here, Node.js handles pipes by default

    // Enhance SSH commands automatically
    let enhancedCommand = command;
    if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
      enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      console.log(`Enhanced SSH command: ${enhancedCommand}`);
    }

    // Get the appropriate spawn configuration for the shell
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;
    
    if (typeof shellToUse === 'string') {
      // Use shell-specific configuration with login flags where appropriate
      spawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand);
      spawnOptions = {
        env: {
          ...process.env,
          TERM: 'xterm-256color'  // Better terminal compatibility
        },
        windowsHide: true,  // Prevent visible console windows on Windows
        // Own process group on POSIX so forceTerminate() can reach the whole
        // tree (e.g. a pipeline or a REPL's own children), not just this
        // direct child — otherwise killing the shell orphans its descendants.
        detached: shouldSpawnAsProcessGroupLeader(),
      };

      // Add shell option if needed (for unknown shells)
      if (spawnConfig.useShellOption) {
        spawnOptions.shell = spawnConfig.useShellOption;
      }
    } else {
      // Boolean or undefined shell - use default shell option behavior
      spawnConfig = {
        executable: enhancedCommand,
        args: [],
        useShellOption: shellToUse
      };
      spawnOptions = {
        shell: shellToUse,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        windowsHide: true,  // Prevent visible console windows on Windows
        detached: shouldSpawnAsProcessGroupLeader(),
      };
    }

    // Repair PATHEXT on Windows before spawning. On some Windows DXT launches
    // the server process inherits a corrupted PATHEXT (e.g. ".CPL"), which we
    // would otherwise propagate via { ...process.env } and break command
    // resolution (git, node, python, rg, ...) in the spawned shell. See #481.
    if (process.platform === 'win32' && spawnOptions.env) {
      spawnOptions.env.PATHEXT = getRepairedPathExt();
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    // Run in an explicit, pre-validated working directory when one was provided.
    if (cwd) {
      spawnOptions.cwd = cwd;
    }

    // Spawn the process with appropriate arguments
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    let output = '';

    // Ensure childProcess.pid is defined before proceeding
    if (!childProcess.pid) {
      // Return a consistent error object instead of throwing
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }

    const sessionId = newSessionId();
    const session: TerminalSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
      sessionId,
    };

    this.sessions.set(childProcess.pid, session);
    // Fire-and-forget, deliberately not awaited: this does real filesystem
    // I/O, which yields the event loop. Awaiting it here — before the
    // stdout/exit listeners below are attached — lets a fast-exiting child
    // (spawn, run, exit in well under a millisecond, e.g. `echo $0`) emit
    // its 'exit' event while we're still off doing I/O; EventEmitter never
    // replays a past event to a listener attached afterward, so the
    // process's completion would be missed entirely and this call would
    // hang until timeoutMs. Durability is best-effort (see persistNewSession's
    // own error handling) specifically so it can never gate the listeners
    // that make output/exit observation work at all.
    void this.persistNewSession(session, command, cwd, String(shellToUse));

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
        if (timeoutTimer) clearTimeout(timeoutTimer);

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      childProcess.stdout.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        // `output` only feeds the wait-phase result and prompt/state detection,
        // so stop growing it once resolved and keep only a bounded tail.
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);
        this.recordStreamOutput(childProcess.pid!, 'stdout', text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

      childProcess.stderr.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);
        this.recordStreamOutput(childProcess.pid!, 'stderr', text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic comprehensive check every 100ms
      periodicCheck = setInterval(() => {
        if (output.trim()) {
          const processState = analyzeProcessState(output, childProcess.pid);
          if (processState.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({
              pid: childProcess.pid!,
              output,
              isBlocked: true
            });
          }
        }
      }, 100);

      // Timeout fallback
      timeoutTimer = setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      childProcess.on('exit', (code: any, signal: any) => {
        if (childProcess.pid) {
          // Store completed session before removing active session
          this.completedSessions.set(childProcess.pid, {
            pid: childProcess.pid,
            outputLines: [...session.outputLines], // Copy line buffer
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars
          });

          // Keep only last 100 completed sessions
          if (this.completedSessions.size > 100) {
            const oldestKey = Array.from(this.completedSessions.keys())[0];
            this.completedSessions.delete(oldestKey);
            this.streamState.delete(oldestKey);
          }

          this.sessions.delete(childProcess.pid);
          this.recordStreamExit(childProcess.pid, code ?? null, signal ?? null);
          void this.persistSessionExit(session.sessionId, code ?? null, signal ?? null);
        }
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Enforce the per-session cap by evicting the oldest lines. Keeps the
    // buffer far below V8's max string length so concatenation and join()
    // can never throw "Invalid string length" and kill the server.
    //
    // Evicting one line at a time via Array.prototype.shift() is O(current
    // array length) per call (V8 arrays are not a deque), which makes
    // trimming back to the cap O(evicted x length) overall — a process
    // emitting many small lines fast can make a single burst of output block
    // this (single-threaded) event loop for many seconds even though memory
    // stays bounded (measured: ~18s to shift 100k times off a ~500k-element
    // array). Count how many oldest lines must go first, then remove them
    // all in one splice() — O(length) total, not O(evicted x length).
    let evictCount = 0;
    let projectedBufferedChars = session.bufferedChars;
    let evictedCharsThisPass = 0;
    while (
      projectedBufferedChars > MAX_BUFFERED_OUTPUT_CHARS &&
      session.outputLines.length - evictCount > 1
    ) {
      const droppedJoinedChars = session.outputLines[evictCount].length + 1; // +1 for its join separator
      projectedBufferedChars -= droppedJoinedChars;
      evictedCharsThisPass += droppedJoinedChars;
      evictCount++;
    }
    if (evictCount > 0) {
      session.outputLines.splice(0, evictCount);
      session.bufferedChars = projectedBufferedChars;
      session.evictedChars += evictedCharsThisPass;
      session.evictedLines += evictCount;
      session.lastReadIndex = Math.max(0, session.lastReadIndex - evictCount);
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000): PaginatedOutputResult | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        session.lastReadIndex,
        (newIndex) => { session.lastReadIndex = newIndex; },
        false,
        undefined
      );
      result.evictedLines = session.evictedLines;
      return result;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        0,  // Completed sessions don't track read position
        () => {},  // No-op for completed sessions
        true,
        completedSession.exitCode,
        runtimeMs
      );
      result.evictedLines = completedSession.evictedLines;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput)
      startIndex = lastReadIndex;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Update lastReadIndex for "new output" behavior
      updateLastRead(Math.min(startIndex + linesToRead.length, totalLines));
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, totalLines - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      const fullOutput = session.outputLines.join('\n');
      return {
        // Absolute since process start (includes evicted output), so the
        // offset stays valid even if the cap evicts lines between
        // snapshot and read.
        totalChars: session.evictedChars + fullOutput.length,
        lineCount: session.evictedLines + session.outputLines.length
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number }): string | null {
    // Check active session first
    const session = this.sessions.get(pid);
    if (session) {
      return TerminalManager.outputSinceSnapshot(session.outputLines, session.evictedChars, snapshot.totalChars);
    }

    // Fallback to completed sessions - process may have finished between snapshot and poll
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return TerminalManager.outputSinceSnapshot(completedSession.outputLines, completedSession.evictedChars, snapshot.totalChars);
    }

    return null;
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets.
   * If eviction dropped part of the unseen output, returns what the buffer
   * still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(outputLines: string[], evictedChars: number, snapshotTotalChars: number): string {
    const fullOutput = outputLines.join('\n');
    const newChars = evictedChars + fullOutput.length - snapshotTotalChars;
    if (newChars <= 0) {
      return ''; // No new output
    }
    return fullOutput.substring(Math.max(0, fullOutput.length - newChars));
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
  }

  forceTerminate(pid: number): boolean {
    const session = this.sessions.get(pid);
    if (session) {
      try {
        terminateProcessTree(pid, 'SIGINT');
        setTimeout(() => {
          if (this.sessions.has(pid)) {
            terminateProcessTree(pid, 'SIGKILL');
          }
        }, 1000);
        return true;
      } catch (error) {
        // Convert error to string, handling both Error objects and other types
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {error: errorMessage, message: `Failed to terminate process ${pid}:`});
        return false;
      }
    }

    // Recovered session (P2.1): no ChildProcess handle, but terminateProcessTree
    // operates on a bare pid — the same process-tree/process-group semantics
    // apply whether or not this server spawned (vs. recovered) the session,
    // so termination behavior does not regress after a restart.
    const recovered = this.recoveredSessions.get(pid);
    if (recovered) {
      try {
        terminateProcessTree(pid, 'SIGINT');
        setTimeout(() => {
          // Escalate first (mirrors the live-session path above) — deleting
          // the entry before this check would skip the SIGKILL escalation
          // for a process that ignores SIGINT.
          if (this.recoveredSessions.has(pid)) {
            terminateProcessTree(pid, 'SIGKILL');
          }
          this.recoveredSessions.delete(pid);
          void this.persistRecoveredSessionTerminated(recovered);
        }, 1000);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {error: errorMessage, message: `Failed to terminate recovered process ${pid}:`});
        return false;
      }
    }

    return false;
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    const live = Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
    const recovered = Array.from(this.recoveredSessions.values()).map(handle => ({
      pid: handle.pid,
      isBlocked: false,
      runtime: now.getTime() - Date.parse(handle.createdAt),
      recovered: true as const,
    }));
    return [...live, ...recovered];
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }

  private recordStreamOutput(pid: number, stream: 'stdout' | 'stderr', text: string): void {
    let state = this.streamState.get(pid);
    if (!state) {
      state = { stdoutTail: '', stderrTail: '', stdoutChars: 0, stderrChars: 0, exited: false, exitCode: null, exitSignal: null };
      this.streamState.set(pid, state);
    }
    if (stream === 'stdout') {
      state.stdoutChars += text.length;
      state.stdoutTail = (state.stdoutTail + text).slice(-STREAM_TAIL_MAX_CHARS);
    } else {
      state.stderrChars += text.length;
      state.stderrTail = (state.stderrTail + text).slice(-STREAM_TAIL_MAX_CHARS);
    }
    this.sessionEvents.emit('output', pid, stream, text);
  }

  private recordStreamExit(pid: number, code: number | null, signal: string | null): void {
    let state = this.streamState.get(pid);
    if (!state) {
      state = { stdoutTail: '', stderrTail: '', stdoutChars: 0, stderrChars: 0, exited: false, exitCode: null, exitSignal: null };
      this.streamState.set(pid, state);
    }
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    state.endTime = new Date();
    this.sessionEvents.emit('exit', pid, code, signal);
  }

  /** Per-stream tails for a DC-spawned session, or undefined if never tracked. */
  getStreamState(pid: number): SessionStreamState | undefined {
    const state = this.streamState.get(pid);
    return state ? { ...state } : undefined;
  }

  /**
   * Ownership lookup: only processes Desktop Commander spawned (active or
   * recently completed) or recovered from its own durable session store.
   * Any other pid returns undefined — callers must refuse it.
   */
  getOwnedSessionStatus(pid: number): OwnedSessionStatus | undefined {
    const active = this.sessions.get(pid);
    if (active) {
      return { pid, ownership: 'active', sessionId: active.sessionId, startTime: active.startTime, exited: false, exitCode: null, exitSignal: null };
    }
    const completed = this.completedSessions.get(pid);
    if (completed) {
      const state = this.streamState.get(pid);
      return {
        pid,
        ownership: 'completed',
        startTime: completed.startTime,
        endTime: completed.endTime,
        exited: true,
        exitCode: completed.exitCode,
        exitSignal: state?.exitSignal ?? null,
      };
    }
    const recovered = this.recoveredSessions.get(pid);
    if (recovered) {
      return { pid, ownership: 'recovered', sessionId: recovered.sessionId, startTime: new Date(recovered.createdAt), exited: false, exitCode: null, exitSignal: null };
    }
    return undefined;
  }

  /**
   * Send one signal to an owned session's process tree. Returns false when
   * the pid is not an owned, still-running session. Never signals an
   * arbitrary pid.
   */
  signalOwnedSession(pid: number, signal: NodeJS.Signals): boolean {
    if (!this.sessions.has(pid) && !this.recoveredSessions.has(pid)) return false;
    terminateProcessTree(pid, signal);
    return true;
  }
}

export const terminalManager = new TerminalManager();