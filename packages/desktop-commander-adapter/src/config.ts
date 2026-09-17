import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import type { AuditEventDraft } from "./audit.js";
import type { CapabilityIssuanceBinding } from "./runtime-registry.js";
import type { RuntimeBootstrapRegistry } from "./runtime-registry.js";

/**
 * Configuration for the local Desktop Commander MCP subprocess and the ACS-side
 * containment roots the adapter enforces before any tool call.
 *
 * Everything is explicit. There is no silent fallback to a globally installed
 * `desktop-commander` package: if the configured local build is not present the
 * adapter refuses to start (fail closed).
 */
export interface DesktopCommanderAdapterConfig {
  /** Executable to spawn (defaults to the current Node binary). */
  command: string;
  /** Arguments (defaults to the local fork's built entrypoint). */
  args: string[];
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Canonicalised roots every path-bearing argument must resolve inside. */
  allowedRoots: string[];
  /** Canonicalised roots that are always denied even when inside an allow root. */
  deniedRoots: string[];
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  /** Hard cap on a single tool result's textual payload after normalisation. */
  maxResultBytes: number;
  /** ACS-only Ed25519 signing material for managed DC calls. */
  capability?: {
    runtimeId: string;
    /** SHA-256 fingerprint of the configured Desktop Commander identity/config. */
    runtimeIdentityConfigFingerprint: string;
    /** Explicit sorted v1 scopes granted to this managed runtime. */
    runtimeScopes: readonly string[];
    keyId: string;
    privateKey: string;
    /** Authoritative ACS control-plane database; never forwarded to DC. */
    databasePath?: string;
    /** Authoritative ACS wiring; absent configuration fails closed at execution. */
    issuanceRegistry?: {
      recordIssuance(input: CapabilityIssuanceBinding): { requestHash: string; approvalId?: string };
    };
    runtimeRegistry?: RuntimeBootstrapRegistry;
    persistAuditEvent?: (event: AuditEventDraft) => void | Promise<void>;
  };
}

const DEFAULT_LOCAL_FORK_ENTRYPOINT = "/home/jacen/projects/desktop-commander/dist/index.js";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

function parseArgsJson(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_ARGS_JSON must be valid JSON"
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_ARGS_JSON must be a JSON array of strings"
    );
  }
  return parsed;
}

function parseRoots(raw: string | undefined, label: string): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!isAbsolute(entry)) {
        throw new ControlStackError(
          "desktop_commander_config_invalid",
          `${label} entries must be absolute paths: ${entry}`
        );
      }
      try {
        return realpathSync(resolve(entry));
      } catch {
        throw new ControlStackError("desktop_commander_config_invalid", `${label} path does not exist: ${entry}`);
      }
    });
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlStackError("desktop_commander_config_invalid", `${label} must be a positive integer`);
  }
  return value;
}

/**
 * Read only the containment boundary needed to authorize an already-injected
 * executor. Production startup still builds the complete managed configuration
 * through `desktopCommanderAdapterConfigFromEnv()` and fails closed without its
 * runtime identity and capability credentials.
 */
export function desktopCommanderContainmentFromEnv(env: NodeJS.ProcessEnv = process.env): {
  allowedRoots: string[];
  deniedRoots: string[];
} {
  const allowedRoots = parseRoots(env.ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS, "ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS");
  if (allowedRoots.length === 0) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS must list at least one absolute containment root when Desktop Commander execution is enabled"
    );
  }
  return {
    allowedRoots,
    deniedRoots: parseRoots(env.ACS_DESKTOP_COMMANDER_DENIED_ROOTS, "ACS_DESKTOP_COMMANDER_DENIED_ROOTS")
  };
}

/**
 * Build the adapter config from environment. Returns `undefined` when Desktop
 * Commander execution is not configured at all, so callers can stay dry-run.
 * Throws (fail closed) when it is partially/incorrectly configured.
 */
export function desktopCommanderAdapterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  authoritativeDatabasePath?: string
): DesktopCommanderAdapterConfig | undefined {
  const explicitCommand = env.ACS_DESKTOP_COMMANDER_COMMAND?.trim() || undefined;
  const explicitArgs = parseArgsJson(env.ACS_DESKTOP_COMMANDER_ARGS_JSON);
  const allowedRoots = parseRoots(env.ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS, "ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS");
  const deniedRoots = parseRoots(env.ACS_DESKTOP_COMMANDER_DENIED_ROOTS, "ACS_DESKTOP_COMMANDER_DENIED_ROOTS");
  const cwd = env.ACS_DESKTOP_COMMANDER_CWD?.trim() || undefined;
  const runtimeId = env.ACS_DESKTOP_COMMANDER_RUNTIME_ID?.trim() || undefined;
  const runtimeIdentityConfigFingerprint =
    env.ACS_DESKTOP_COMMANDER_RUNTIME_IDENTITY_CONFIG_FINGERPRINT?.trim() || undefined;
  const runtimeScopes = parseArgsJson(env.ACS_DESKTOP_COMMANDER_RUNTIME_SCOPES_JSON);
  const keyId = env.ACS_DESKTOP_COMMANDER_CAPABILITY_KEY_ID?.trim() || undefined;
  const privateKey = env.ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY?.trim() || undefined;

  const configured =
    explicitCommand !== undefined ||
    explicitArgs !== undefined ||
    allowedRoots.length > 0 ||
    env.ACS_EXECUTION_BACKEND?.trim() === "desktop_commander";
  if (!configured) return undefined;

  let command: string;
  let args: string[];
  if (explicitCommand !== undefined) {
    command = explicitCommand;
    args = explicitArgs ?? [];
  } else {
    // Safe default: run the local fork's built entrypoint with the current node,
    // but only if it actually exists on disk.
    const entrypoint = explicitArgs?.[0] ?? DEFAULT_LOCAL_FORK_ENTRYPOINT;
    if (!existsSync(entrypoint)) {
      throw new ControlStackError(
        "desktop_commander_config_invalid",
        `Desktop Commander entrypoint not found: ${entrypoint}. Build the local fork or set ACS_DESKTOP_COMMANDER_COMMAND/ARGS_JSON.`
      );
    }
    command = process.execPath;
    args = explicitArgs ?? [entrypoint];
  }
  if (args.includes("--standalone")) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "managed Desktop Commander must not be launched with --standalone"
    );
  }

  if (allowedRoots.length === 0) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS must list at least one absolute containment root when Desktop Commander execution is enabled"
    );
  }
  const databasePath = authoritativeDatabasePath ?? (env.ACS_DB_PATH?.trim() || undefined);
  if (!runtimeId || !runtimeIdentityConfigFingerprint || !runtimeScopes || !keyId || !privateKey || !databasePath) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "managed Desktop Commander requires runtime id, runtime identity fingerprint/scopes, capability key id, private key, and the authoritative database path"
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(runtimeIdentityConfigFingerprint)) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_RUNTIME_IDENTITY_CONFIG_FINGERPRINT must be lowercase SHA-256 hex"
    );
  }
  const knownScopes = new Set([
    "fs.read",
    "fs.write",
    "process.exec",
    "process.spawn",
    "network.read",
    "network.write"
  ]);
  if (
    runtimeScopes.length === 0 ||
    new Set(runtimeScopes).size !== runtimeScopes.length ||
    runtimeScopes.some((scope) => !knownScopes.has(scope)) ||
    runtimeScopes.some((scope, index) => index > 0 && runtimeScopes[index - 1]! >= scope)
  ) {
    throw new ControlStackError(
      "desktop_commander_config_invalid",
      "ACS_DESKTOP_COMMANDER_RUNTIME_SCOPES_JSON must be a sorted, unique nonempty v1 scope array"
    );
  }

  return {
    command,
    args,
    cwd,
    allowedRoots,
    deniedRoots,
    connectTimeoutMs: parsePositiveInt(
      env.ACS_DESKTOP_COMMANDER_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "ACS_DESKTOP_COMMANDER_CONNECT_TIMEOUT_MS"
    ),
    requestTimeoutMs: parsePositiveInt(
      env.ACS_DESKTOP_COMMANDER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "ACS_DESKTOP_COMMANDER_REQUEST_TIMEOUT_MS"
    ),
    maxResultBytes: parsePositiveInt(
      env.ACS_DESKTOP_COMMANDER_MAX_RESULT_BYTES,
      DEFAULT_MAX_RESULT_BYTES,
      "ACS_DESKTOP_COMMANDER_MAX_RESULT_BYTES"
    ),
    capability: { runtimeId, runtimeIdentityConfigFingerprint, runtimeScopes, keyId, privateKey, databasePath }
  };
}
