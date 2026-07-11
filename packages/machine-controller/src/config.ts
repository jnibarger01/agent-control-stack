import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";

const rawConfigSchema = z.object({
  server: z
    .object({
      name: z.string().min(1).default("personal-machine-controller"),
      transport: z.literal("stdio").default("stdio"),
      version: z.string().min(1).default("0.1.0")
    })
    .optional(),
  security: z
    .object({
      default_policy: z.literal("deny").default("deny"),
      require_approval_for_mutations: z.boolean().default(true),
      redact_secrets: z.boolean().default(true),
      max_output_bytes: z.number().int().positive().default(200_000),
      command_timeout_ms: z.number().int().positive().default(120_000)
    })
    .optional(),
  paths: z.object({
    allow: z.array(z.string().min(1)).min(1),
    deny: z.array(z.string().min(1)).default([])
  }),
  commands: z
    .object({
      allow_readonly: z.array(z.string().min(1)).default([]),
      deny: z.array(z.string().min(1)).default([])
    })
    .optional(),
  audit: z
    .object({
      log_path: z.string().min(1).default(".acs/audit/mcp.jsonl")
    })
    .optional()
});

export interface MachineControllerConfig {
  server: {
    name: string;
    transport: "stdio";
    version: string;
  };
  security: {
    defaultPolicy: "deny";
    requireApprovalForMutations: boolean;
    redactSecrets: boolean;
    maxOutputBytes: number;
    commandTimeoutMs: number;
  };
  paths: {
    allow: string[];
    deny: string[];
  };
  commands: {
    allowReadonly: string[];
    deny: string[];
  };
  audit: {
    logPath: string;
  };
}

type RawConfig = z.infer<typeof rawConfigSchema>;

export function loadMachineControllerConfig(configPath: string | URL | undefined): MachineControllerConfig {
  if (!configPath) {
    throw new ControlStackError("config_missing", "MCP controller config path is required");
  }

  const filePath = typeof configPath === "string" ? configPath : fileURLToPath(configPath);
  if (!existsSync(filePath)) {
    throw new ControlStackError("config_missing", `MCP controller config not found: ${filePath}`);
  }

  const raw = rawConfigSchema.parse(parseConfigText(readFileSync(filePath, "utf8")));
  return normalizeConfig(raw, dirname(resolve(filePath)));
}

export function parseConfigText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  return parseSimpleYaml(trimmed);
}

function normalizeConfig(raw: RawConfig, baseDir: string): MachineControllerConfig {
  const server = raw.server ?? { name: "personal-machine-controller", transport: "stdio" as const, version: "0.1.0" };
  const security = raw.security ?? {
    default_policy: "deny" as const,
    require_approval_for_mutations: true,
    redact_secrets: true,
    max_output_bytes: 200_000,
    command_timeout_ms: 120_000
  };
  const commands = raw.commands ?? { allow_readonly: [], deny: [] };
  const audit = raw.audit ?? { log_path: ".acs/audit/mcp.jsonl" };

  return {
    server,
    security: {
      defaultPolicy: security.default_policy,
      requireApprovalForMutations: security.require_approval_for_mutations,
      redactSecrets: security.redact_secrets,
      maxOutputBytes: security.max_output_bytes,
      commandTimeoutMs: security.command_timeout_ms
    },
    paths: {
      allow: raw.paths.allow.map((entry) => realExistingPath(entry, baseDir)),
      deny: raw.paths.deny.map((entry) => absolutePath(entry, baseDir))
    },
    commands: {
      allowReadonly: commands.allow_readonly,
      deny: commands.deny
    },
    audit: {
      logPath: absolutePath(audit.log_path, baseDir)
    }
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section: Record<string, unknown> | undefined;
  let arrayTarget: unknown[] | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const top = /^([A-Za-z0-9_]+):\s*$/.exec(line);
    if (top) {
      section = {};
      result[top[1] ?? ""] = section;
      arrayTarget = undefined;
      continue;
    }

    const keyValue = /^  ([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (keyValue && section) {
      const key = keyValue[1] ?? "";
      const value = keyValue[2] ?? "";
      if (value === "") {
        arrayTarget = [];
        section[key] = arrayTarget;
      } else {
        section[key] = parseScalar(value);
        arrayTarget = undefined;
      }
      continue;
    }

    const item = /^    -\s*(.*)$/.exec(line);
    if (item && arrayTarget) {
      arrayTarget.push(parseScalar(item[1] ?? ""));
      continue;
    }

    throw new ControlStackError("config_invalid", `unsupported config line: ${rawLine}`);
  }

  return result;
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, "");
}

function absolutePath(path: string, baseDir: string): string {
  const expanded = path.startsWith("~/") ? resolve(process.env.HOME ?? "/", path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function realExistingPath(path: string, baseDir: string): string {
  const absolute = absolutePath(path, baseDir);
  try {
    return realpathSync(absolute);
  } catch {
    throw new ControlStackError("config_invalid", `allowed path does not exist: ${absolute}`);
  }
}
