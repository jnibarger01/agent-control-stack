import { accessSync, constants } from "node:fs";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { SqliteWorkItemStore } from "@agent-control-stack/work-items";

const execFileAsync = promisify(execFile);

export const SYSTEM_BOOTSTRAP_ACTOR_ID = "actor_system_bootstrap";
export const DISCOVERY_PROBE_TIMEOUT_MS = 3_000;
export const DISCOVERY_ERROR_MAX_LENGTH = 200;

const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface CanonicalDiscoveryTarget {
  id: "codex-cli" | "claude-code" | "gemini-cli" | "opencode-local" | "hermes-local" | "openclaw-bridge";
  executable: string;
  probeArgs: readonly ["--version"];
  workerCapacity: boolean;
}

export const CANONICAL_DISCOVERY_TARGETS: readonly CanonicalDiscoveryTarget[] = [
  { id: "codex-cli", executable: "codex", probeArgs: ["--version"], workerCapacity: true },
  { id: "claude-code", executable: "claude", probeArgs: ["--version"], workerCapacity: true },
  { id: "gemini-cli", executable: "gemini", probeArgs: ["--version"], workerCapacity: true },
  { id: "opencode-local", executable: "opencode", probeArgs: ["--version"], workerCapacity: true },
  { id: "hermes-local", executable: "hermes", probeArgs: ["--version"], workerCapacity: false },
  { id: "openclaw-bridge", executable: "openclaw", probeArgs: ["--version"], workerCapacity: false }
];

export type DiscoveryOutcome = "available" | "missing" | "error" | "skipped";

export interface DiscoveryResult {
  id: CanonicalDiscoveryTarget["id"];
  outcome: DiscoveryOutcome;
}

export interface ProbeResult {
  ok: boolean;
  timedOut?: boolean;
  error?: string;
}

export interface DiscoverLocalActorsDeps {
  resolveExecutable: (executable: string) => string | undefined;
  probe: (executablePath: string, args: readonly string[]) => Promise<ProbeResult>;
  now?: Date;
}

export interface DiscoverLocalActorsOptions extends Partial<DiscoverLocalActorsDeps> {
  store: Pick<SqliteWorkItemStore, "getRegistryAgent" | "recordAgentHeartbeat">;
}

export function isWorkerCapacityTarget(agentId: string): boolean {
  const target = CANONICAL_DISCOVERY_TARGETS.find((candidate) => candidate.id === agentId);
  return target ? target.workerCapacity : agentId !== "hermes-local" && agentId !== "openclaw-bridge";
}

export function sanitizeDiscoveryError(value: string): string {
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }
  return normalized.replace(/\s+/g, " ").trim().slice(0, DISCOVERY_ERROR_MAX_LENGTH);
}

export function resolveExecutableOnPath(name: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  if (!EXECUTABLE_NAME.test(name)) {
    return undefined;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function probeExecutableVersion(executablePath: string, args: readonly string[]): Promise<ProbeResult> {
  try {
    await execFileAsync(executablePath, [...args], {
      timeout: DISCOVERY_PROBE_TIMEOUT_MS,
      encoding: "utf8"
    });
    return { ok: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
    const timedOut = err.killed === true || err.signal === "SIGTERM";
    return {
      ok: false,
      ...(timedOut ? { timedOut: true } : {}),
      error: sanitizeDiscoveryError(err.message ?? String(error))
    };
  }
}

export async function discoverLocalActors(options: DiscoverLocalActorsOptions): Promise<DiscoveryResult[]> {
  const resolveExecutable = options.resolveExecutable ?? resolveExecutableOnPath;
  const probe = options.probe ?? probeExecutableVersion;
  const now = options.now ?? new Date();
  const results: DiscoveryResult[] = [];

  for (const target of CANONICAL_DISCOVERY_TARGETS) {
    const existing = options.store.getRegistryAgent(target.id);
    if (!existing) {
      results.push({ id: target.id, outcome: "skipped" });
      continue;
    }

    const resolved = resolveExecutable(target.executable);
    if (!resolved) {
      options.store.recordAgentHeartbeat(target.id, {
        status: "OFFLINE",
        lastError: "executable_not_found",
        actorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
        now
      });
      results.push({ id: target.id, outcome: "missing" });
      continue;
    }

    const probed = await probe(resolved, target.probeArgs);
    if (probed.ok) {
      options.store.recordAgentHeartbeat(target.id, {
        status: "AVAILABLE",
        actorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
        now
      });
      results.push({ id: target.id, outcome: "available" });
      continue;
    }

    options.store.recordAgentHeartbeat(target.id, {
      status: "ERROR",
      lastError: probed.timedOut ? "probe_timeout" : sanitizeDiscoveryError(probed.error ?? "probe_failed"),
      actorId: SYSTEM_BOOTSTRAP_ACTOR_ID,
      now
    });
    results.push({ id: target.id, outcome: "error" });
  }

  return results;
}
