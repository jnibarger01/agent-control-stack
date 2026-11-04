/**
 * JC-owned bounded process engine. Shell execution is a distinct, approval-gated
 * tool; legacy start_process retains its argv-only shell refusal.
 * Every workload runs inside the bubblewrap sandbox (sandbox.ts): no host PIDs,
 * read-only filesystem outside the roots, masked credential stores and
 * control-plane state. A policy without a proven sandbox launches nothing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcChildEnv } from './child-env.js';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { assertSandboxReady, sandboxArgv } from './sandbox.js';
import { IntegrationError } from './integrations.js';

const MAX_OUTPUT = 256 * 1024;
const MAX_SESSIONS = 32;
const KILL_GRACE_MS = 1000;
const QUIET_MS = 150;
const DENIED_BASE = new Set(['sh','bash','dash','zsh','ksh','mksh','ash','fish','csh','tcsh','rbash','sudo','su','doas','pkexec','env','busybox']);
const EXTRA_ENV = new Set(['LANG','LC_ALL','LC_CTYPE','TZ','TERM','COLORTERM','NO_COLOR','FORCE_COLOR']);
interface Stream { data: Buffer; start: number; end: number }
interface Session {
  sessionId: string; pid: number; argv: string[]; cwd: string; owner: string;
  stdout: Stream; stderr: Stream; exitCode: number | null; signal: string | null;
  done: boolean; child: ChildProcessWithoutNullStreams; timer: NodeJS.Timeout;
}
export interface ProcessRegistry {
  start(args: Record<string, unknown>, policy: JcFsPolicy, owner?: string): Record<string, unknown>;
  run(args: Record<string, unknown>, policy: JcFsPolicy, owner?: string): Promise<Record<string, unknown>>;
  terminal(args: Record<string, unknown>, policy: JcFsPolicy, owner?: string): Promise<Record<string, unknown>>;
  interact(args: Record<string, unknown>, owner?: string): Promise<Record<string, unknown>>;
  read(args: Record<string, unknown>, owner?: string): Promise<Record<string, unknown>>;
  output(args: Record<string, unknown>, owner?: string): Record<string, unknown>;
  list(owner?: string): { processes: Record<string, unknown>[] };
  kill(args: Record<string, unknown>, owner?: string): Record<string, unknown>;
  close(): void;
}
function invalid(message: string): never { throw new IntegrationError('invalid_argument', message); }
function integer(value: unknown, fallback: number, max: number, min = 1): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) invalid('invalid process bound');
  return n;
}
function append(stream: Stream, chunk: Buffer): void {
  stream.end += chunk.length;
  stream.data = Buffer.concat([stream.data, chunk]);
  if (stream.data.length > MAX_OUTPUT) stream.data = stream.data.subarray(stream.data.length - MAX_OUTPUT);
  stream.start = stream.end - stream.data.length;
}
function executable(value: string, shell = false, shells: readonly string[] = ['/bin/bash']): string {
  if (!path.isAbsolute(value) || value.includes('\0')) invalid('executable must be an absolute path');
  let real: string;
  try { real = fs.realpathSync(value); fs.accessSync(real, fs.constants.X_OK); }
  catch { throw new IntegrationError('not_found', 'executable does not exist or is not executable'); }
  if (shell) {
    if (!shells.some((allowed) => { try { return fs.realpathSync(allowed) === real; } catch { return false; } })) {
      throw new IntegrationError('command_denied', 'shell is not configured');
    }
  } else if (DENIED_BASE.has(path.basename(value)) || DENIED_BASE.has(path.basename(real))) {
    throw new IntegrationError('command_denied', 'shells and privilege tools cannot be started through start_process');
  }
  return real;
}
function environment(value: unknown): NodeJS.ProcessEnv {
  if (value === undefined) return jcChildEnv();
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid environment');
  const entries = Object.entries(value);
  if (entries.length > 32) invalid('too many environment variables');
  const extra: Record<string,string> = {};
  for (const [name, val] of entries) {
    if (!EXTRA_ENV.has(name) || typeof val !== 'string' || val.length > 4096 || val.includes('\0')) {
      invalid('environment variable is not permitted');
    }
    extra[name] = val;
  }
  return jcChildEnv(extra);
}
export function createProcessRegistry(options: { shells?: readonly string[] } = {}): ProcessRegistry {
  const sessions = new Map<string,Session>();
  const shells = options.shells ?? ['/bin/bash'];
  function find(id: unknown, owner = 'stdio'): Session {
    const s = sessions.get(String(id ?? ''));
    if (!s || s.owner !== owner) throw new IntegrationError('not_found','session not found');
    return s;
  }
  function terminate(s: Session): void {
    if (s.done) return;
    try { process.kill(-s.pid,'SIGTERM'); } catch { s.child.kill('SIGTERM'); }
    const timer = setTimeout(() => {
      try { process.kill(-s.pid,'SIGKILL'); } catch { /* already gone */ }
    },KILL_GRACE_MS);
    timer.unref();
    s.child.once('close',()=>clearTimeout(timer));
  }
  function launch(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, owner: string | undefined, policy: JcFsPolicy): Session {
    if (!policy.workload) throw new IntegrationError('JC_SANDBOX_UNAVAILABLE', 'no workload sandbox is configured; nothing ran');
    assertSandboxReady(policy.workload.policy, policy.workload.homeDir, policy.workload.stateDir);
    const sandboxed = sandboxArgv(policy.workload.policy, argv, cwd);
    // The sandbox has a private /tmp; never point a workload at a host temp dir.
    const workloadEnv = policy.workload.policy.isolation === 'bwrap' ? { ...env, TMPDIR: '/tmp' } : env;
    if (sessions.size >= MAX_SESSIONS) {
      const finished = [...sessions.values()].find((s) => s.done);
      if (!finished) throw new IntegrationError('too_many_processes','at most 32 managed processes may run at once');
      sessions.delete(finished.sessionId);
    }
    const child = spawn(sandboxed[0]!,sandboxed.slice(1),{cwd,env:workloadEnv,shell:false,stdio:'pipe',detached:true});
    if (!child.pid) { child.on('error',()=>{}); throw new IntegrationError('start_failed','process did not start'); }
    const stream = (): Stream => ({data:Buffer.alloc(0),start:0,end:0});
    const s: Session = {sessionId:'proc_'+randomBytes(16).toString('hex'),pid:child.pid,argv,cwd,owner:owner ?? 'stdio',
      stdout:stream(),stderr:stream(),exitCode:null,signal:null,done:false,child,
      timer:setTimeout(()=>terminate(s),timeoutMs)};
    child.stdout.on('data',(chunk: Buffer)=>append(s.stdout,chunk));
    child.stderr.on('data',(chunk: Buffer)=>append(s.stderr,chunk));
    child.stdin.on('error',()=>{});
    child.on('error',()=>{s.done=true;s.exitCode=-1;clearTimeout(s.timer);});
    child.on('close',(code,signal)=>{try { process.kill(-s.pid,'SIGKILL'); } catch { /* group already gone */ } s.done=true;s.exitCode=code;s.signal=signal;clearTimeout(s.timer);});
    sessions.set(s.sessionId,s);
    return s;
  }
  function output(args: Record<string,unknown>,owner?: string): Record<string,unknown> {
    const s=find(args.sessionId,owner);
    const a=integer(args.stdoutOffset ?? args.offset,0,Number.MAX_SAFE_INTEGER,0);
    const b=integer(args.stderrOffset ?? args.offset,0,Number.MAX_SAFE_INTEGER,0);
    return {sessionId:s.sessionId,pid:s.pid,exitCode:s.exitCode,signal:s.signal,running:!s.done,
      stdout:s.stdout.data.subarray(Math.max(0,a-s.stdout.start)).toString('utf8'),
      stderr:s.stderr.data.subarray(Math.max(0,b-s.stderr.start)).toString('utf8'),
      stdoutStartOffset:s.stdout.start,stderrStartOffset:s.stderr.start,
      nextStdoutOffset:s.stdout.end,nextStderrOffset:s.stderr.end,
      truncated:a<s.stdout.start || b<s.stderr.start};
  }
  async function read(args: Record<string,unknown>,owner?: string): Promise<Record<string,unknown>> {
    const s=find(args.sessionId,owner);
    const wait=integer(args.waitMs,0,60_000,0);
    const a=integer(args.stdoutOffset ?? args.offset,0,Number.MAX_SAFE_INTEGER,0);
    const b=integer(args.stderrOffset ?? args.offset,0,Number.MAX_SAFE_INTEGER,0);
    const until=Date.now()+wait;
    while (!s.done && s.stdout.end<=a && s.stderr.end<=b && Date.now()<until) {
      await new Promise((resolve)=>setTimeout(resolve,Math.min(10,Math.max(1,until-Date.now()))));
    }
    return output(args,owner);
  }
  async function shell(args: Record<string,unknown>,policy: JcFsPolicy,owner: string|undefined,interactive: boolean): Promise<Record<string,unknown>> {
    const cwd=containJcPath(args.cwd,policy);
    const selected=args.shell === undefined ? shells[0] : args.shell;
    if (typeof selected !== 'string') invalid('shell must be a configured absolute executable');
    const sh=executable(selected,true,shells);
    const timeout=integer(args.timeoutMs,interactive?300_000:30_000,interactive?3_600_000:600_000);
    if (!interactive && (typeof args.command!=='string' || !args.command || Buffer.byteLength(args.command)>16*1024 || args.command.includes('\0'))) invalid('command must be bounded text');
    const argv=interactive?[sh,'-i']:[sh,'-lc',args.command as string];
    // PTY allocation belongs to JC; Python's standard library needs no DC modules.
    const actual=interactive || args.pty === true
      ? ['/usr/bin/python3',fileURLToPath(new URL('./pty-helper.py',import.meta.url)),...argv] : argv;
    const s=launch(actual,cwd,environment(args.env),timeout,owner,policy);
    const wait=integer(args.waitMs,interactive?0:10_000,60_000,0);
    // run_command waits for completion, rather than returning on the first chunk.
    const until=Date.now()+wait;
    while (!s.done && Date.now()<until) await new Promise((resolve)=>setTimeout(resolve,10));
    return {...output({sessionId:s.sessionId},owner),cwd,timeoutMs:timeout,pty:interactive || args.pty===true};
  }
  return {
    start(args,policy,owner) {
      if (!Array.isArray(args.argv)||args.argv.length<1||args.argv.length>32) invalid('argv must contain 1 to 32 strings');
      const argv=args.argv.map((part)=> {
        if (typeof part!=='string'||!part||part.length>1024||part.includes('\0')) invalid('invalid argv entry');
        return part;
      });
      const cwd=containJcPath(args.cwd,policy);
      const timeoutMs=integer(args.timeoutMs,30_000,600_000);
      const s=launch([executable(argv[0]!),...argv.slice(1)],cwd,jcChildEnv(),timeoutMs,owner,policy);
      return {sessionId:s.sessionId,pid:s.pid,cwd,argv,timeoutMs};
    },
    run:(args,policy,owner)=>shell(args,policy,owner,false),
    terminal:(args,policy,owner)=>shell(args,policy,owner,true),
    async interact(args,owner) {
      const s=find(args.sessionId,owner);
      if (typeof args.input!=='string'||Buffer.byteLength(args.input)>64*1024) invalid('input must be bounded text');
      if (s.done || s.child.stdin.destroyed) throw new IntegrationError('process_exited','process has exited');
      const stdoutOffset=s.stdout.end,stderrOffset=s.stderr.end;
      await new Promise<void>((resolve,reject)=>s.child.stdin.write(args.input as string,(error)=>error?reject(new IntegrationError('process_exited','stdin closed')):resolve()));
      // A terminal echoes input immediately; keep collecting until the output
      // has been quiet for QUIET_MS (or waitMs elapses / the process exits), so
      // the command's own output is returned, not just the echo.
      const wait=integer(args.waitMs,1000,60_000,0);
      const until=Date.now()+wait;
      let lastSize=-1, quietSince=Date.now();
      while (!s.done && Date.now()<until) {
        const size=s.stdout.end+s.stderr.end;
        if (size!==lastSize) { lastSize=size; quietSince=Date.now(); }
        else if (size>stdoutOffset+stderrOffset && Date.now()-quietSince>=QUIET_MS) break;
        await new Promise((resolve)=>setTimeout(resolve,10));
      }
      return output({sessionId:s.sessionId,stdoutOffset,stderrOffset},owner);
    },
    read,output,
    list(owner='stdio') { return {processes:[...sessions.values()].filter((s)=>s.owner===owner).map((s)=>({
      sessionId:s.sessionId,pid:s.pid,cwd:s.cwd,argv:s.argv,exitCode:s.exitCode,signal:s.signal,running:!s.done}))}; },
    kill(args,owner='stdio') {
      const s=[...sessions.values()].find((s)=>s.owner===owner && (s.sessionId===args.sessionId || (typeof args.pid==='number' && s.pid===args.pid)));
      if (!s) throw new IntegrationError('not_found','managed process not found');
      if (s.done) return {sessionId:s.sessionId,pid:s.pid,alreadyExited:true};
      terminate(s);
      return {sessionId:s.sessionId,pid:s.pid,signal:'SIGTERM',escalatesAfterMs:KILL_GRACE_MS};
    },
    close() { for (const s of sessions.values()) terminate(s); }
  };
}
