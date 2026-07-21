import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { requireRegisteredService, resolveRegisteredConfigTarget } from "./registry.js";

const serviceInputSchema = z.object({ serviceId: z.string().min(1) }).strict();
const configPatchSchema = z
  .object({
    op: z.enum(["add", "replace", "remove"]),
    path: z.string().regex(/^\/[a-z][a-z0-9_]*$/),
    value: z.unknown().optional()
  })
  .strict()
  .superRefine((patch, context) => {
    if (patch.op !== "remove" && patch.value === undefined) {
      context.addIssue({ code: "custom", path: ["value"], message: "patch value is required" });
    }
  });
const configInputSchema = z
  .object({
    targetId: z.string().min(1),
    patch: z.array(configPatchSchema).min(1).max(20),
    expectedCurrentHash: z.string().regex(/^[a-f0-9]{64}$/i).optional()
  })
  .strict();

export interface ServiceCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceRestartResult {
  serviceId: string;
  unit: string;
  ok: boolean;
  before: { healthy: boolean; output: string };
  after: { healthy: boolean; output: string };
  rollbackAttempted: boolean;
  rollbackOk?: boolean;
  exitCode: number | null;
  stderr: string;
}

export interface ServiceRestartOptions {
  run?: (args: string[]) => Promise<ServiceCommandResult>;
}

export function previewRegisteredServiceRestart(config: MachineControllerConfig, input: unknown) {
  const parsed = serviceInputSchema.parse(input);
  const service = requireRegisteredService(parsed.serviceId);
  return {
    serviceId: service.id,
    version: service.version,
    unit: service.unit,
    scope: service.scope,
    healthUrl: "healthUrl" in service ? service.healthUrl : undefined,
    approvalRequired: true,
    workerOnly: true,
    cwd: config.paths.allow[0]
  };
}

export async function executeRegisteredServiceRestart(
  config: MachineControllerConfig,
  input: unknown,
  options: ServiceRestartOptions = {}
): Promise<ServiceRestartResult> {
  const preview = previewRegisteredServiceRestart(config, input);
  const run = options.run ?? ((args: string[]) => runSystemctl(config, args));
  const healthArgs = ["--user", "is-active", "--quiet", preview.unit];
  const restartArgs = ["--user", "restart", preview.unit];
  const before = await run(healthArgs);
  const restart = await run(restartArgs);
  const after = await run(healthArgs);
  const healthy = restart.exitCode === 0 && after.exitCode === 0;
  if (healthy) {
    return {
      serviceId: preview.serviceId,
      unit: preview.unit,
      ok: true,
      before: { healthy: before.exitCode === 0, output: boundedOutput(before.stdout) },
      after: { healthy: after.exitCode === 0, output: boundedOutput(after.stdout) },
      rollbackAttempted: false,
      exitCode: restart.exitCode,
      stderr: boundedOutput(restart.stderr)
    };
  }

  const rollback = await run(restartArgs);
  return {
    serviceId: preview.serviceId,
    unit: preview.unit,
    ok: false,
    before: { healthy: before.exitCode === 0, output: boundedOutput(before.stdout) },
    after: { healthy: after.exitCode === 0, output: boundedOutput(after.stdout) },
    rollbackAttempted: true,
    rollbackOk: rollback.exitCode === 0,
    exitCode: restart.exitCode,
    stderr: boundedOutput([restart.stderr, rollback.stderr].filter(Boolean).join("\n"))
  };
}

export function previewRegisteredConfigChange(config: MachineControllerConfig, input: unknown) {
  const parsed = configInputSchema.parse(input);
  const target = resolveRegisteredConfigTarget(config, parsed.targetId);
  const current = readConfigObject(target.path);
  const next = applyPatches(target.allowedKeys, current.value, parsed.patch);
  return {
    targetId: target.id,
    version: target.version,
    path: target.path,
    format: target.format,
    currentHash: current.hash,
    nextHash: stableHash(next),
    changed: stableHash(next) !== current.hash,
    backupRequired: true,
    atomicReplace: true,
    current: current.value,
    next
  };
}

export function applyRegisteredConfigChange(config: MachineControllerConfig, input: unknown) {
  const parsed = configInputSchema.parse(input);
  const target = resolveRegisteredConfigTarget(config, parsed.targetId);
  const current = readConfigObject(target.path);
  if (parsed.expectedCurrentHash && parsed.expectedCurrentHash !== current.hash) {
    throw new ControlStackError("config_hash_mismatch", `config target changed since preview: ${target.id}`);
  }
  const next = applyPatches(target.allowedKeys, current.value, parsed.patch);
  const nextHash = stableHash(next);
  if (nextHash === current.hash) {
    return {
      targetId: target.id,
      path: target.path,
      changed: false,
      currentHash: current.hash,
      nextHash,
      backupPath: undefined
    };
  }

  mkdirSync(dirname(target.path), { recursive: true });
  const backupPath = `${target.path}.bak-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  const mode = existsSync(target.path) ? statSync(target.path).mode & 0o777 : 0o600;
  if (existsSync(target.path)) {
    copyFileSync(target.path, backupPath);
  }
  const tempPath = `${target.path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode });
    chmodSync(tempPath, mode);
    renameSync(tempPath, target.path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new ControlStackError("config_change_failed", error instanceof Error ? error.message : "config change failed");
  }
  return { targetId: target.id, path: target.path, changed: true, currentHash: current.hash, nextHash, backupPath };
}

function readConfigObject(path: string): { value: Record<string, unknown>; hash: string } {
  if (!existsSync(path)) {
    const value = {};
    return { value, hash: stableHash(value) };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config target must contain a JSON object");
    }
    const value = parsed as Record<string, unknown>;
    return { value, hash: stableHash(value) };
  } catch (error) {
    throw new ControlStackError("config_invalid", error instanceof Error ? error.message : "config target is invalid");
  }
}

function applyPatches(
  allowedKeys: readonly string[],
  source: Record<string, unknown>,
  patches: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>
): Record<string, unknown> {
  const next = { ...source };
  for (const patch of patches) {
    const key = patch.path.slice(1);
    if (!allowedKeys.includes(key)) {
      throw new ControlStackError("config_key_not_allowed", `config key is not registered: ${key}`);
    }
    if (patch.op === "remove") {
      delete next[key];
      continue;
    }
    validateConfigValue(key, patch.value);
    next[key] = patch.value;
  }
  return next;
}

function validateConfigValue(key: string, value: unknown): void {
  if (!Number.isInteger(value)) {
    throw new ControlStackError("config_value_invalid", `config value must be an integer: ${key}`);
  }
  const number = value as number;
  if (key === "worker_poll_interval_ms" && (number < 1_000 || number > 3_600_000)) {
    throw new ControlStackError("config_value_invalid", `worker poll interval is out of bounds: ${number}`);
  }
  if (key === "max_evidence_bytes" && (number < 1_000 || number > 20_000_000)) {
    throw new ControlStackError("config_value_invalid", `max evidence bytes is out of bounds: ${number}`);
  }
}

async function runSystemctl(config: MachineControllerConfig, args: string[]): Promise<ServiceCommandResult> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn("systemctl", args, {
      cwd: config.paths.allow[0],
      env: systemdUserCommandEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedOutput(`${stdout}${chunk.toString("utf8")}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedOutput(`${stderr}${chunk.toString("utf8")}`);
    });
    child.on("error", (error) => resolve({ exitCode: null, stdout, stderr: error.message }));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

export function systemdUserCommandEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? 1000;
  return {
    HOME: process.env.HOME,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SYSTEMD_COLORS: "0",
    SYSTEMD_PAGER: "cat",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`
  };
}

function boundedOutput(value: string): string {
  return value.length <= 20_000 ? value : `${value.slice(0, 20_000)}\n[truncated]`;
}
