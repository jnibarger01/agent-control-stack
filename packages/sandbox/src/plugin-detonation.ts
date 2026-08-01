import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SECRET_NAME = /(token|secret|password|api[_-]?key|private[_-]?key|credential)/iu;
const DANGEROUS_CODE = /(child_process|execSync|spawn\(|fetch\(|https?:\/\/|net\.|process\.env|chmod|chown)/u;

export interface PluginPolicyRule {
  capability: "filesystem" | "network" | "process" | "secrets";
  decision: "allow" | "deny" | "require_approval";
  reason: string;
}

export interface DetonationReport {
  pluginId: string;
  verdict: "pass" | "warn" | "fail";
  risks: string[];
  requestedCapabilities: string[];
  observedBehavior: {
    filesRead: string[];
    filesWritten: string[];
    networkHosts: string[];
    processesSpawned: string[];
  };
  recommendedPolicy: PluginPolicyRule[];
  smokeTest: { attempted: boolean; ok: boolean; timedOut: boolean; output: string };
}

export interface DetonatePluginOptions {
  pluginId: string;
  pluginPath: string;
  smokeCommand?: string[];
  timeoutMs?: number;
  /** Test-only dependency injection; production uses Bubblewrap when available. */
  commandRunner?: (command: string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;
}

interface CommandResult {
  ok: boolean;
  timedOut: boolean;
  output: string;
  processesSpawned: string[];
}

export async function detonatePlugin(options: DetonatePluginOptions): Promise<DetonationReport> {
  if (!options.pluginId.trim()) throw new Error("pluginId is required");
  const source = resolve(options.pluginPath);
  const sourceStats = await stat(source);
  if (!sourceStats.isDirectory()) throw new Error("pluginPath must be a directory for MVP detonation");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be an integer between 100 and 120000");
  }

  const staticScan = await scanPlugin(source);
  const sandboxRoot = await mkdtemp(join(tmpdir(), `acs-plugin-${options.pluginId.replace(/[^a-z0-9_-]/giu, "_")}-`));
  try {
    const pluginRoot = join(sandboxRoot, "plugin");
    await cp(source, pluginRoot, { recursive: true, force: false, errorOnExist: false });
    await cp(source, join(sandboxRoot, "before"), { recursive: true, force: false, errorOnExist: false });

    const risks = [...staticScan.risks];
    let smokeTest: DetonationReport["smokeTest"] = {
      attempted: false,
      ok: false,
      timedOut: false,
      output: ""
    };
    let processesSpawned: string[] = [];
    if (options.smokeCommand) {
      const commandRunner = options.commandRunner ?? runNetworkDisabled;
      const result = await commandRunner(options.smokeCommand, pluginRoot, timeoutMs);
      smokeTest = { attempted: true, ok: result.ok, timedOut: result.timedOut, output: result.output };
      processesSpawned = result.processesSpawned;
      if (!result.ok) risks.push(result.timedOut ? "smoke test timed out" : "smoke test failed");
    }

    const filesWritten = await changedFiles(join(sandboxRoot, "before"), pluginRoot);
    const verdict =
      staticScan.requestedCapabilities.some((capability) => capability === "secrets" || capability === "network") ||
      risks.some((risk) => /secret|network|failed|timed out|outside/iu.test(risk))
      ? "fail"
      : options.smokeCommand && !smokeTest.ok
        ? "warn"
        : "pass";
    return {
      pluginId: options.pluginId,
      verdict,
      risks: [...new Set(risks)],
      requestedCapabilities: staticScan.requestedCapabilities,
      observedBehavior: {
        filesRead: staticScan.filesRead,
        filesWritten,
        networkHosts: [],
        processesSpawned
      },
      recommendedPolicy: recommendedPolicy(staticScan.requestedCapabilities, risks),
      smokeTest
    };
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

async function scanPlugin(root: string): Promise<{
  risks: string[];
  requestedCapabilities: string[];
  filesRead: string[];
}> {
  const filesRead: string[] = [];
  const risks: string[] = [];
  const capabilities = new Set<string>();
  const files = await filesUnder(root);
  for (const file of files) {
    const rel = relative(root, file);
    filesRead.push(rel);
    if (SECRET_NAME.test(basename(file))) risks.push(`secret-like file name: ${rel}`);
    if (!/\.(?:[cm]?[jt]s|json|mjs|cjs|py|sh|yaml|yml)$/iu.test(file)) continue;
    const content = await readFile(file, "utf8");
    if (DANGEROUS_CODE.test(content)) {
      if (/(child_process|execSync|spawn\()/u.test(content)) capabilities.add("process");
      if (/(fetch\(|https?:\/\/|net\.)/u.test(content)) capabilities.add("network");
      if (/process\.env/u.test(content)) capabilities.add("secrets");
      risks.push(`dynamic capability reference: ${rel}`);
    }
  }
  return { risks, requestedCapabilities: [...capabilities].sort(), filesRead: filesRead.sort() };
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function changedFiles(beforeRoot: string, afterRoot: string): Promise<string[]> {
  const [before, after] = await Promise.all([snapshotFiles(beforeRoot), snapshotFiles(afterRoot)]);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of await filesUnder(root)) {
    const content = await readFile(file);
    snapshot.set(relative(root, file), createHash("sha256").update(content).digest("hex"));
  }
  return snapshot;
}

async function runNetworkDisabled(command: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const executable = await findExecutable("bwrap");
  if (!executable) {
    return {
      ok: false,
      timedOut: false,
      output: "Bubblewrap is required for plugin smoke execution with network disabled",
      processesSpawned: []
    };
  }
  const home = join(cwd, "..", "home");
  const wrapped = [
    "--die-with-parent",
    "--unshare-net",
    "--bind",
    cwd,
    "/plugin",
    "--bind",
    home,
    "/home",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--chdir",
    "/plugin",
    "--setenv",
    "HOME",
    "/home",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--",
    ...command
  ];
  try {
    const childProcess = await import("node:child_process");
    if (!childProcess.execFile) {
      return { ok: false, timedOut: false, output: "execFile is unavailable", processesSpawned: [] };
    }
    const result = await new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
      childProcess.execFile(
        executable,
        wrapped,
        { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home }, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolveResult({ stdout, stderr }))
      );
    });
    return { ok: true, timedOut: false, output: `${result.stdout}${result.stderr}`.slice(0, MAX_OUTPUT_BYTES), processesSpawned: [command[0]] };
  } catch (error) {
    const typed = error as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      timedOut: typed.killed === true || typed.signal === "SIGTERM",
      output: `${typed.stdout ?? ""}${typed.stderr ?? ""}${typed.message ?? ""}`.slice(0, MAX_OUTPUT_BYTES),
      processesSpawned: [command[0]]
    };
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the fixed, non-user-controlled executable paths.
    }
  }
  return undefined;
}

function recommendedPolicy(capabilities: string[], risks: string[]): PluginPolicyRule[] {
  return [
    { capability: "filesystem", decision: "require_approval", reason: "plugin filesystem access is not trusted by default" },
    {
      capability: "network",
      decision: capabilities.includes("network") || risks.some((risk) => risk.includes("network")) ? "deny" : "allow",
      reason: "network is disabled during MVP detonation"
    },
    {
      capability: "process",
      decision: capabilities.includes("process") ? "deny" : "allow",
      reason: "process spawning requires an explicit policy decision"
    },
    { capability: "secrets", decision: "deny", reason: "no secrets are mounted in the detonation environment" }
  ];
}
