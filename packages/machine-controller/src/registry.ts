import { basename, join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { resolveSafePath } from "./path.js";

export const connectorActionRegistry = [
  {
    id: "acs.command.preview",
    version: "1.0",
    kind: "cmd.preview",
    executionBoundary: "gateway-to-worker",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.command.run",
    version: "1.0",
    kind: "cmd.run",
    executionBoundary: "worker-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.filesystem.read_text",
    version: "1.0",
    kind: "fs.read",
    executionBoundary: "worker-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.filesystem.stat",
    version: "1.0",
    kind: "fs.stat",
    executionBoundary: "worker-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.agent.codex.preview",
    version: "1.0",
    kind: "agent.preview",
    executionBoundary: "gateway-to-worker",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.agent.codex.run",
    version: "1.0",
    kind: "agent.prompt",
    executionBoundary: "worker-only",
    approval: "configured"
  },
  {
    id: "acs.result.get",
    version: "1.0",
    kind: "result.get",
    executionBoundary: "gateway-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.evidence.list",
    version: "1.0",
    kind: "evidence.list",
    executionBoundary: "gateway-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.evidence.get",
    version: "1.0",
    kind: "evidence.get",
    executionBoundary: "gateway-only",
    approval: "none",
    evidence: "required"
  },
  {
    id: "acs.service.restart",
    version: "1.0",
    kind: "service.restart",
    executionBoundary: "worker-only",
    approval: "human"
  },
  {
    id: "acs.config.change",
    version: "1.0",
    kind: "config.change",
    executionBoundary: "worker-only",
    approval: "human",
    rollback: "backup-and-atomic-replace"
  }
] as const;

export type ConnectorActionDefinition = (typeof connectorActionRegistry)[number];

export const registeredCommandRegistry = [
  { id: "os.metadata", version: "1.0", command: "uname", args: ["-a"], description: "Read kernel and OS metadata." },
  { id: "cpu.memory", version: "1.0", command: "free", args: ["-h"], description: "Read memory totals and availability." },
  { id: "filesystem.usage", version: "1.0", command: "df", args: ["-h"], description: "Read filesystem usage." },
  {
    id: "failed.systemd.units",
    version: "1.0",
    command: "systemctl",
    args: ["--user", "--failed", "--no-legend", "--no-pager"],
    description: "List failed user services."
  },
  { id: "docker.status", version: "1.0", command: "docker", args: ["ps", "--no-trunc"], description: "List running containers." },
  { id: "docker.disk", version: "1.0", command: "docker", args: ["system", "df"], description: "Read Docker disk usage." },
  { id: "tailscale.status", version: "1.0", command: "tailscale", args: ["status"], description: "Read Tailscale status." },
  {
    id: "pending.updates",
    version: "1.0",
    command: "apt",
    args: ["list", "--upgradable"],
    description: "Read pending package updates."
  },
  {
    id: "journal.tail",
    version: "1.0",
    command: "journalctl",
    args: ["--user", "-n", "100", "--no-pager", "-o", "short-iso"],
    description: "Read a bounded user journal tail."
  },
  {
    id: "storage.nvme",
    version: "1.0",
    command: "lsblk",
    args: ["-o", "NAME,SIZE,TYPE,MOUNTPOINT"],
    description: "Read block-device and mount metadata."
  }
] as const;

export type RegisteredCommandId = (typeof registeredCommandRegistry)[number]["id"];
export type RegisteredCommandDefinition = (typeof registeredCommandRegistry)[number];
export interface ResolvedRegisteredCommand {
  commandId: string;
  id: string;
  version: string;
  command: string;
  args: string[];
  description: string;
  cwd: string;
}

export const registeredFilesystemRoots = [
  { id: "acs-repo", description: "The configured ACS repository root." }
] as const;

export const registeredServiceRegistry = [
  {
    id: "acs-gateway",
    version: "1.0",
    unit: "acs-gateway.service",
    scope: "user",
    healthUrl: "http://127.0.0.1:3000/health"
  },
  { id: "acs-worker", version: "1.0", unit: "acs-worker.service", scope: "user" },
  { id: "acs-tunnel", version: "1.0", unit: "acs-tunnel.service", scope: "user" },
  { id: "acs-connector-test", version: "1.0", unit: "acs-connector-test.service", scope: "user" }
] as const;

export type RegisteredServiceId = (typeof registeredServiceRegistry)[number]["id"];
export type RegisteredServiceDefinition = (typeof registeredServiceRegistry)[number];

export const registeredConfigTargetRegistry = [
  {
    id: "acs-connector-settings",
    version: "1.0",
    rootId: "acs-repo",
    relativePath: "storage/acs-connector-settings.json",
    format: "json",
    allowedKeys: ["worker_poll_interval_ms", "max_evidence_bytes"] as const
  }
] as const;

export type RegisteredConfigTargetId = (typeof registeredConfigTargetRegistry)[number]["id"];
export type RegisteredConfigTarget = (typeof registeredConfigTargetRegistry)[number];

const registeredCommandInputSchema = z
  .object({ commandId: z.string().min(1), cwd: z.string().min(1).optional(), rootId: z.string().min(1).optional() })
  .strict();

export function getRegisteredCommand(commandId: string): RegisteredCommandDefinition | undefined {
  return registeredCommandRegistry.find((entry) => entry.id === commandId);
}

export function resolveRegisteredCommand(
  config: MachineControllerConfig,
  input: unknown
): ResolvedRegisteredCommand {
  let parsed: z.infer<typeof registeredCommandInputSchema>;
  try {
    parsed = registeredCommandInputSchema.parse(input);
  } catch {
    throw new ControlStackError("command_input_invalid", "registered commands accept only commandId and an optional cwd");
  }
  const definition = getRegisteredCommand(parsed.commandId);
  if (!definition) {
    throw new ControlStackError("command_not_registered", `registered command is unknown: ${parsed.commandId}`);
  }
  if (parsed.cwd && parsed.rootId) {
    throw new ControlStackError("command_input_invalid", "registered commands accept either cwd or rootId, not both");
  }
  const cwd = resolveSafePath(config, parsed.cwd ?? resolveRegisteredRoot(config, parsed.rootId ?? "acs-repo")).realPath;
  return { ...definition, commandId: parsed.commandId, args: [...definition.args], cwd };
}

export function resolveRegisteredRoot(config: MachineControllerConfig, rootId: string): string {
  if (!registeredFilesystemRoots.some((entry) => entry.id === rootId)) {
    throw new ControlStackError("filesystem_root_not_registered", `filesystem root is unknown: ${rootId}`);
  }

  const configuredRepo = config.paths.allow.find((entry) => basename(entry) === "agent-control-stack");
  return resolveSafePath(config, configuredRepo ?? config.paths.allow[0] ?? "").realPath;
}

export function getRegisteredService(serviceId: string): RegisteredServiceDefinition | undefined {
  return registeredServiceRegistry.find((entry) => entry.id === serviceId);
}

export function requireRegisteredService(serviceId: string): RegisteredServiceDefinition {
  const definition = getRegisteredService(serviceId);
  if (!definition) {
    throw new ControlStackError("service_not_registered", `service is not registered: ${serviceId}`);
  }
  return definition;
}

export function getRegisteredConfigTarget(targetId: string): RegisteredConfigTarget | undefined {
  return registeredConfigTargetRegistry.find((entry) => entry.id === targetId);
}

export function resolveRegisteredConfigTarget(
  config: MachineControllerConfig,
  targetId: string
): RegisteredConfigTarget & { path: string } {
  const definition = getRegisteredConfigTarget(targetId);
  if (!definition) {
    throw new ControlStackError("config_target_not_registered", `config target is unknown: ${targetId}`);
  }
  const root = resolveRegisteredRoot(config, definition.rootId);
  return { ...definition, path: resolveSafePath(config, join(root, definition.relativePath)).realPath };
}
