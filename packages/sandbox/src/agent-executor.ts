import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStackError, isPathContained, redactValue } from "@agent-control-stack/shared";
import { assertExecutableWorkItem, type ActionRequest, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_WORKSPACE_ENTRIES = 50_000;
const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;
const GUEST_WORKSPACE = "/var/tmp";
const LOCAL_OLLAMA_SOCKET = "/tmp/acs-ollama.sock";
const LOCAL_INFERENCE_RUNNER = "/tmp/acs-local-inference-runner.js";
const DEFAULT_LOCAL_OLLAMA_MODEL = "qwen2.5-coder:7b";
const ACS_RUNTIME_SQLITE_SIDECAR = /^storage\/local\.db-(?:wal|shm)$/;

export const agentExecutionRequestSchema = z
  .object({
    agent: z.string().min(1).max(64),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    prompt: z.string().min(1).max(20_000),
    cwd: z.string().min(1),
    permissionMode: z.literal("read-only"),
    timeoutMs: z.number().int().positive().max(60 * 60 * 1_000).default(DEFAULT_TIMEOUT_MS),
    networkAccess: z.literal("none"),
    expectedOutputs: z.array(z.string().min(1).max(1_000)).max(100).default([])
  })
  .strict();

export type AgentExecutionRequest = z.infer<typeof agentExecutionRequestSchema>;

export interface ContainedCommandInput {
  executable: string;
  args: string[];
  cwd: string;
  sandboxExecutable?: string;
  timeoutMs: number;
  terminationGraceMs: number;
  maxOutputBytes: number;
  mounts?: readonly [source: string, destination: string][];
}

export interface ContainedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  processTreeTerminated: boolean;
}

export interface AgentExecutorOptions {
  enabled?: boolean;
  bubblewrapPath?: string;
  providerExecutable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  commandFactory?: (request: AgentExecutionRequest) => {
    executable: string;
    args: string[];
    mounts?: readonly [source: string, destination: string][];
  };
}

export interface AgentSandboxResult {
  ok: boolean;
  executionMode: "sandboxed_agent" | "not_started";
  output: string;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  agent?: string;
  provider?: string;
  model?: string;
  workspaceBeforeHash?: string;
  workspaceAfterHash?: string;
  changedPaths?: string[];
  sandboxIdentity?: string;
}

const disabledProviders = new Set(["claude", "claude-code", "gemini", "opencode", "openclaw", "pi"]);

export async function executeAgentSandboxed(
  workItem: WorkItem,
  options: AgentExecutorOptions = {}
): Promise<AgentSandboxResult> {
  assertExecutableWorkItem(workItem);
  const action = workItem.requestedActions.find((candidate) => candidate.kind === "agent.prompt");
  if (!action) {
    return notStarted("work item has no agent.prompt action");
  }

  let request: AgentExecutionRequest;
  try {
    request = parseAgentRequest(workItem, action);
  } catch (error) {
    return notStarted(errorMessage(error));
  }
  const providerError = validateProvider(request);
  if (providerError) {
    return notStarted(providerError, request);
  }
  if (!options.enabled) {
    return notStarted("real agent execution is disabled; enable the Bubblewrap Codex profile explicitly", request);
  }
  if (process.platform === "win32") {
    return notStarted("agent process-tree termination is not proven on Windows", request);
  }

  const bubblewrapPath = options.bubblewrapPath ?? process.env.ACS_BWRAP_PATH ?? "/usr/bin/bwrap";
  if (!isExecutableFile(bubblewrapPath)) {
    return notStarted(`required Bubblewrap executable is unavailable: ${bubblewrapPath}`, request);
  }

  const workspace = resolveWorkspace(request.cwd);
  if (!workspace.ok) {
    return notStarted(workspace.error, request);
  }

  let before: WorkspaceManifest;
  try {
    before = snapshotWorkspace(workspace.path);
  } catch (error) {
    return notStarted(`workspace verification could not start: ${errorMessage(error)}`, request);
  }

  let localRelay: LocalOllamaRelay | undefined;
  const started = Date.now();
  let contained: ContainedCommandResult;
  try {
    const command = options.commandFactory
      ? options.commandFactory(request)
      : await (async () => {
          const relay = await createLocalOllamaRelay();
          localRelay = relay;
          return codexCommand(request, options.providerExecutable, options.nodeExecutable, relay.socketPath);
        })();
    contained = await runContainedReadonlyCommand({
      executable: command.executable,
      args: command.args,
      cwd: workspace.path,
      sandboxExecutable: bubblewrapPath,
      timeoutMs: Math.min(request.timeoutMs, options.timeoutMs ?? request.timeoutMs),
      terminationGraceMs: options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
      mounts: command.mounts
    });
  } catch (error) {
    return notStarted(`contained agent process could not start: ${errorMessage(error)}`, request);
  } finally {
    await localRelay?.close();
  }

  let after: WorkspaceManifest;
  try {
    after = snapshotWorkspace(workspace.path);
  } catch (error) {
    return {
      ok: false,
      executionMode: "sandboxed_agent",
      output: redactText(contained.stdout),
      stderr: redactText(contained.stderr),
      error: `workspace verification failed after execution: ${errorMessage(error)}`,
      exitCode: contained.exitCode,
      timedOut: contained.timedOut,
      durationMs: Date.now() - started,
      agent: request.agent,
      provider: request.provider,
      ...(request.model ? { model: request.model } : {}),
      workspaceBeforeHash: before.hash,
      sandboxIdentity: "bubblewrap:read-only-workspace,no-network,local-ollama-unix-socket"
    };
  }

  const changedPaths = changedManifestPaths(before, after);
  const processTreeError = contained.processTreeTerminated ? undefined : "agent process tree termination was not proven";
  const error =
    processTreeError ??
    (changedPaths.length ? `workspace changed during read-only agent execution: ${changedPaths.join(", ")}` : undefined) ??
    (contained.timedOut ? "agent execution timed out" : undefined) ??
    (contained.exitCode === 0 ? undefined : `agent exited with code ${contained.exitCode ?? "unknown"}`);

  return {
    ok: !error,
    executionMode: "sandboxed_agent",
    output: redactText(contained.stdout),
    ...(contained.stderr ? { stderr: redactText(contained.stderr) } : {}),
    ...(error ? { error } : {}),
    exitCode: contained.exitCode,
    timedOut: contained.timedOut,
    durationMs: Date.now() - started,
    agent: request.agent,
    provider: request.provider,
    ...(request.model ? { model: request.model } : {}),
    workspaceBeforeHash: before.hash,
    workspaceAfterHash: after.hash,
    ...(changedPaths.length ? { changedPaths } : {}),
    sandboxIdentity: "bubblewrap:read-only-workspace,no-network,local-ollama-unix-socket"
  };
}

export async function runContainedReadonlyCommand(input: ContainedCommandInput): Promise<ContainedCommandResult> {
  if (process.platform === "win32") {
    throw new ControlStackError("sandbox_unavailable", "Bubblewrap process containment is unavailable on Windows");
  }
  const bubblewrapPath = input.sandboxExecutable ?? process.env.ACS_BWRAP_PATH ?? "/usr/bin/bwrap";
  if (!isExecutableFile(bubblewrapPath)) {
    throw new ControlStackError("sandbox_unavailable", `required Bubblewrap executable is unavailable: ${bubblewrapPath}`);
  }
  const invocation = bubblewrapInvocation(input);
  const started = Date.now();

  return await new Promise<ContainedCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(bubblewrapPath, invocation, {
      cwd: input.cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    let processTreeTerminated = true;
    let terminationError: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let completionTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationError = signalProcessGroup(child.pid, "SIGTERM") ?? terminationError;
      forceTimer = setTimeout(() => {
        terminationError = signalProcessGroup(child.pid, "SIGKILL") ?? terminationError;
        completionTimer = setTimeout(() => {
          processTreeTerminated = false;
          finish();
        }, Math.min(input.terminationGraceMs, 1_000));
      }, input.terminationGraceMs);
    }, input.timeoutMs);

    const finish = () => {
      if (settled || !childClosed && !timedOut) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (completionTimer) clearTimeout(completionTimer);
      if (terminationError && !timedOut) {
        rejectPromise(terminationError);
        return;
      }
      resolvePromise({
        exitCode,
        stdout: redactText(stdout),
        stderr: redactText(stderr),
        timedOut,
        durationMs: Date.now() - started,
        processTreeTerminated
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.on("error", (error) => {
      if (!childClosed) {
        terminationError = error;
        childClosed = true;
        finish();
      }
    });
    child.on("close", (code) => {
      childClosed = true;
      exitCode = code;
      void (async () => {
        if (!(await waitForProcessGroupGone(child.pid, timedOut ? input.terminationGraceMs : 1_000))) {
          if (timedOut) {
            processTreeTerminated = false;
          } else {
            terminationError = new Error("agent process group did not exit cleanly");
          }
        }
        finish();
      })();
    });
  });
}

function parseAgentRequest(workItem: WorkItem, action: ActionRequest): AgentExecutionRequest {
  const params = action.params;
  const parsed = agentExecutionRequestSchema.safeParse({
    ...params,
    cwd: params.cwd ?? workItem.target.cwd,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    expectedOutputs: params.expectedOutputs ?? []
  });
  if (!parsed.success) {
    throw new ControlStackError("agent_request_invalid", "agent.prompt parameters do not satisfy the read-only execution contract");
  }
  return parsed.data;
}

function validateProvider(request: AgentExecutionRequest): string | undefined {
  if (disabledProviders.has(request.agent.toLowerCase()) || disabledProviders.has(request.provider.toLowerCase())) {
    return `agent provider is disabled until an independent containment profile is proven: ${request.provider}`;
  }
  if (request.agent.toLowerCase() !== "codex" || !["codex", "codex-cli"].includes(request.provider.toLowerCase())) {
    return `unsupported agent provider; only the Codex Bubblewrap profile is enabled: ${request.agent}/${request.provider}`;
  }
  if (request.permissionMode !== "read-only" || request.networkAccess !== "none") {
    return "agent execution requires permissionMode=read-only and networkAccess=none";
  }
  return undefined;
}

function codexCommand(
  request: AgentExecutionRequest,
  providerExecutable = process.env.ACS_CODEX_PATH ?? "codex",
  nodeExecutable = process.env.ACS_NODE_PATH ?? process.execPath,
  localSocketPath: string
): { executable: string; args: string[]; mounts: readonly [source: string, destination: string][] } {
  const codexPath = resolveCommandPath(providerExecutable);
  const nodePath = realpathSync(nodeExecutable);
  const packageRoot = dirname(dirname(codexPath));
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "local-inference-runner.js");
  if (!existsSync(runnerPath)) {
    throw new Error(`local inference runner is unavailable: ${runnerPath}`);
  }
  const model = request.model ?? process.env.ACS_CODEX_LOCAL_MODEL ?? DEFAULT_LOCAL_OLLAMA_MODEL;
  return {
    executable: "/usr/bin/node",
    args: [LOCAL_INFERENCE_RUNNER, LOCAL_OLLAMA_SOCKET, model, request.prompt],
    mounts: [
      [nodePath, "/usr/bin/node"],
      [packageRoot, "/usr/local"],
      [runnerPath, LOCAL_INFERENCE_RUNNER],
      [localSocketPath, LOCAL_OLLAMA_SOCKET]
    ]
  };
}

interface LocalOllamaRelay {
  socketPath: string;
  close: () => Promise<void>;
}

async function createLocalOllamaRelay(): Promise<LocalOllamaRelay> {
  const directory = mkdtempSync(join(tmpdir(), "acs-ollama-relay-"));
  const socketPath = join(directory, "ollama.sock");
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: 11434 });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 4;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
  } catch (error) {
    cleanupRelayArtifacts(server, socketPath, directory);
    throw error;
  }

  return {
    socketPath,
    close: () => closeLocalOllamaRelay(server, socketPath, directory)
  };
}

async function closeLocalOllamaRelay(server: Server, socketPath: string, directory: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  cleanupRelayArtifacts(server, socketPath, directory);
}

function cleanupRelayArtifacts(server: Server, socketPath: string, directory: string): void {
  if (server.listening) {
    server.close();
  }
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function bubblewrapInvocation(input: ContainedCommandInput): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/root",
    "--tmpfs",
    "/run/user",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--ro-bind",
    input.cwd,
    GUEST_WORKSPACE
  ];
  for (const [source, destination] of input.mounts ?? []) {
    args.push("--ro-bind", source, destination);
  }
  args.push(
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp/acs-agent-home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--chdir",
    GUEST_WORKSPACE,
    input.executable,
    ...input.args
  );
  return args;
}

interface WorkspaceEntry {
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  hash?: string;
  target?: string;
}

interface WorkspaceManifest {
  hash: string;
  entries: Map<string, WorkspaceEntry>;
}

function snapshotWorkspace(root: string): WorkspaceManifest {
  const entries = new Map<string, WorkspaceEntry>();
  const visit = (path: string, relativePath: string) => {
    if (relativePath && ACS_RUNTIME_SQLITE_SIDECAR.test(relativePath)) {
      return;
    }
    if (entries.size >= MAX_WORKSPACE_ENTRIES) {
      throw new Error(`workspace exceeds ${MAX_WORKSPACE_ENTRIES} manifest entries`);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = realpathSync(path);
      if (!isPathContained(root, resolvedTarget)) {
        throw new Error(`workspace symlink escapes the workspace: ${relativePath || "."}`);
      }
      entries.set(relativePath, { type: "symlink", size: 0, mode: stat.mode, target });
      return;
    }
    if (stat.isDirectory()) {
      entries.set(relativePath, { type: "directory", size: 0, mode: stat.mode });
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (stat.isFile()) {
      if (stat.size > MAX_WORKSPACE_FILE_BYTES) {
        throw new Error(`workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes: ${relativePath}`);
      }
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      entries.set(relativePath, { type: "file", size: stat.size, mode: stat.mode, hash });
      return;
    }
    entries.set(relativePath, { type: "other", size: stat.size, mode: stat.mode });
  };
  visit(root, "");
  const serialized = [...entries.entries()].map(([path, entry]) => [path, entry]);
  return { entries, hash: createHash("sha256").update(JSON.stringify(serialized)).digest("hex") };
}

function changedManifestPaths(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...paths].filter((path) => JSON.stringify(before.entries.get(path)) !== JSON.stringify(after.entries.get(path))).sort();
}

function resolveWorkspace(cwd: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!isAbsolute(cwd) || !existsSync(cwd)) {
    return { ok: false, error: "agent workspace must be an existing absolute path" };
  }
  try {
    const path = realpathSync(cwd);
    return statSync(path).isDirectory() ? { ok: true, path } : { ok: false, error: "agent workspace is not a directory" };
  } catch (error) {
    return { ok: false, error: `agent workspace is unavailable: ${errorMessage(error)}` };
  }
}

function resolveCommandPath(command: string): string {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  const resolved = execFileSync("which", [command], { encoding: "utf8" }).trim();
  if (!resolved) throw new Error(`provider executable is not on PATH: ${command}`);
  return realpathSync(resolved);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): Error | undefined {
  if (pid === undefined) return new Error("contained process has no PID");
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    return hasErrorCode(error, "ESRCH") ? undefined : asError(error);
  }
}

async function waitForProcessGroupGone(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  if (pid === undefined) return false;
  const deadline = Date.now() + Math.max(timeoutMs, 100);
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return `${Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

function redactText(value: string): string {
  return String(redactValue(value));
}

function notStarted(error: string, request?: AgentExecutionRequest): AgentSandboxResult {
  return {
    ok: false,
    executionMode: "not_started",
    output: "",
    error,
    ...(request
      ? {
          agent: request.agent,
          provider: request.provider,
          ...(request.model ? { model: request.model } : {})
        }
      : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
