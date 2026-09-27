import type { z } from "zod";
import { DC_TOOL_ARGUMENT_SCHEMAS, type DcCapabilityToolName } from "./argument-schemas.js";

/**
 * Canonical Desktop Commander tool contract for ACS-managed execution
 * (ADR 0019).
 *
 * This is the ONE authoritative definition of:
 *  - which Desktop Commander tools exist and their managed disposition,
 *  - the ACS scope each capability tool requires,
 *  - risk class and whether ACS requires human approval,
 *  - the strict argument schema ACS validates before issuing a capability,
 *  - transport-only argument metadata (`origin`) and where the capability
 *    envelope travels in MCP `_meta`.
 *
 * ACS (packages/desktop-commander-adapter) imports it directly. The MCP
 * gateway and Desktop Commander (vendor/desktop-commander) keep in-process
 * copies because they are built outside the workspace graph; the root drift
 * test (tests/e2e/dc-tool-contract-drift.test.ts) fails when any of them
 * disagrees with this file, and contracts/desktop-commander/*.json plus the
 * DC test fixtures are generated from it (scripts/dc-tool-manifest.ts).
 *
 * Nothing here is an authorization decision. A `capability` tool still needs
 * a per-call ACS-signed capability that Desktop Commander verifies itself.
 */

export const ACS_DC_CAPABILITY_VERSION = "acs.dc.v1" as const;

/** The complete acs.dc.v1 scope vocabulary (issuer and verifier must agree). */
export const ACS_DC_SCOPES = Object.freeze([
  "fs.read",
  "fs.write",
  "network.read",
  "network.write",
  "process.exec",
  "process.spawn"
] as const);
export type AcsDcScope = (typeof ACS_DC_SCOPES)[number];

export type DcRiskClass = "read_only" | "safe_mutation" | "requires_approval" | "destructive";

export type DcToolClass =
  | "read_only"
  | "filesystem_mutation"
  | "process_execution"
  | "process_control"
  | "configuration_mutation"
  | "unsupported";

export interface DcCapabilityToolContract {
  readonly name: DcCapabilityToolName;
  readonly managed: "capability";
  readonly toolClass: DcToolClass;
  readonly riskClass: DcRiskClass;
  /** ACS requires a recorded human approval before it will issue a capability. */
  readonly requiresApproval: boolean;
  /** The single acs.dc.v1 scope this tool consumes. */
  readonly scope: AcsDcScope;
  /** Strict argument schema; unknown keys are rejected. */
  readonly argsSchema: z.ZodTypeAny;
  readonly reason: string;
}

export interface DcUnsupportedToolContract {
  readonly name: string;
  readonly managed: "unsupported";
  readonly toolClass: DcToolClass;
  readonly reason: string;
}

export type DcToolContract = DcCapabilityToolContract | DcUnsupportedToolContract;

type CapabilityRow = Omit<DcCapabilityToolContract, "name" | "managed" | "argsSchema">;

// Capability tools. Scope mapping is a capability vocabulary choice, not an
// inference from argument shape: `start_process` creates a process, and
// process inspection consumes process authority even without a path argument.
const capabilityRows: Readonly<Record<DcCapabilityToolName, CapabilityRow>> = {
  get_config: row("read_only", "read_only", false, "fs.read", "configuration read"),
  get_runtime_identity: row(
    "read_only",
    "read_only",
    false,
    "process.exec",
    "stable runtime identity + redacted device state; no credentials or decisions"
  ),
  get_file_info: row("read_only", "read_only", false, "fs.read", "contained path metadata"),
  list_directory: row("read_only", "read_only", false, "fs.read", "contained directory listing"),
  read_file: row("read_only", "read_only", false, "fs.read", "contained file read; URL reads forbidden"),
  read_multiple_files: row("read_only", "read_only", false, "fs.read", "contained file reads"),
  start_search: row("read_only", "read_only", false, "fs.read", "contained ripgrep search session"),
  get_more_search_results: row("read_only", "read_only", false, "fs.read", "pages an existing search session"),
  list_searches: row("read_only", "read_only", false, "fs.read", "lists search sessions"),
  list_sessions: row("read_only", "read_only", false, "process.exec", "lists DC terminal sessions"),
  list_processes: row("read_only", "read_only", false, "process.exec", "process listing"),
  read_process_output: row("read_only", "read_only", false, "process.exec", "reads DC session output"),
  get_usage_stats: row("read_only", "read_only", false, "process.exec", "DC usage counters"),
  create_directory: row("filesystem_mutation", "safe_mutation", true, "fs.write", "approval-bound mutation"),
  write_file: row("filesystem_mutation", "requires_approval", true, "fs.write", "approval-bound mutation"),
  edit_block: row("filesystem_mutation", "requires_approval", true, "fs.write", "approval-bound mutation"),
  move_file: row("filesystem_mutation", "requires_approval", true, "fs.write", "approval-bound mutation"),
  start_process: row(
    "process_execution",
    "requires_approval",
    true,
    "process.spawn",
    "approval-bound; command validated and executable resolved by ACS"
  ),
  health: row("read_only", "read_only", false, "process.exec", "degraded-mode-safe status; no secrets"),
  last_error: row("read_only", "read_only", false, "process.exec", "sanitized diagnostics; arguments as hashes only"),
  capability_manifest: row(
    "read_only",
    "read_only",
    false,
    "process.exec",
    "mechanical capability; authorization external"
  ),
  operation_preview: row(
    "read_only",
    "read_only",
    false,
    "fs.read",
    "mechanical preview; nested paths contained by ACS"
  ),
  git_state: row("read_only", "read_only", false, "fs.read", "contained read-only git inspection"),
  verify_head: row("read_only", "read_only", false, "fs.read", "contained HEAD comparison"),
  secret_scan: row("read_only", "read_only", false, "fs.read", "contained preflight scan; values never returned"),
  wait_for_process: row("read_only", "read_only", false, "process.exec", "observes DC-owned sessions only"),
  run_command: row(
    "process_execution",
    "requires_approval",
    true,
    "process.spawn",
    "approval-bound; argv validated by ACS command policy, executable resolved"
  ),
  terminate_process: row(
    "process_control",
    "requires_approval",
    true,
    "process.exec",
    "approval-bound; DC-owned sessions only"
  ),
  apply_patch: row(
    "filesystem_mutation",
    "requires_approval",
    true,
    "fs.write",
    "approval-bound; hash-guarded atomic write"
  ),
  snapshot_path: row(
    "filesystem_mutation",
    "requires_approval",
    true,
    "fs.write",
    "approval-bound; writes the DC snapshot area"
  ),
  restore_snapshot: row(
    "filesystem_mutation",
    "requires_approval",
    true,
    "fs.write",
    "approval-bound; restores a sealed DC snapshot"
  )
};

// Tools Desktop Commander registers that are deterministically denied in
// managed mode (`managed_tool_unsupported`, never `unknown_tool`).
const unsupportedRows: Readonly<Record<string, Omit<DcUnsupportedToolContract, "name" | "managed">>> = {
  write_pdf: { toolClass: "filesystem_mutation", reason: "no ACS argument schema yet" },
  interact_with_process: {
    toolClass: "process_execution",
    reason: "free-form input to a live process cannot be bound to a validated command"
  },
  acpx_list_sessions: { toolClass: "process_execution", reason: "spawns the acpx CLI" },
  acpx_get_session: { toolClass: "process_execution", reason: "spawns the acpx CLI" },
  acpx_exec: { toolClass: "process_execution", reason: "arbitrary agent execution" },
  acpx_prompt: { toolClass: "process_execution", reason: "arbitrary agent execution" },
  kill_process: { toolClass: "process_control", reason: "arbitrary PID signal; not scoped to DC-owned processes" },
  force_terminate: { toolClass: "process_control", reason: "no ACS argument schema yet" },
  stop_search: { toolClass: "process_control", reason: "no ACS argument schema yet; searches self-expire" },
  acpx_cancel: { toolClass: "process_control", reason: "acpx session control" },
  set_config_value: {
    toolClass: "configuration_mutation",
    reason: "would let a caller widen DC's own mechanical limits; ACS owns authority"
  },
  get_recent_tool_calls: { toolClass: "unsupported", reason: "discloses other principals' tool arguments" },
  get_prompts: { toolClass: "unsupported", reason: "product onboarding prompt injection, not a machine operation" },
  give_feedback_to_desktop_commander: { toolClass: "unsupported", reason: "opens an external network destination" },
  track_ui_event: { toolClass: "unsupported", reason: "UI telemetry, not an agent tool" },
  service_status: {
    toolClass: "read_only",
    reason: "network probes; ACS defines no network-capable managed Desktop Commander tool"
  }
};

function row(
  toolClass: DcToolClass,
  riskClass: DcRiskClass,
  requiresApproval: boolean,
  scope: AcsDcScope,
  reason: string
): CapabilityRow {
  return { toolClass, riskClass, requiresApproval, scope, reason };
}

function buildManifest(): ReadonlyMap<string, DcToolContract> {
  const entries = new Map<string, DcToolContract>();
  for (const name of Object.keys(capabilityRows) as DcCapabilityToolName[]) {
    entries.set(
      name,
      Object.freeze({
        name,
        managed: "capability",
        argsSchema: DC_TOOL_ARGUMENT_SCHEMAS[name],
        ...capabilityRows[name]
      })
    );
  }
  for (const [name, entry] of Object.entries(unsupportedRows)) {
    if (entries.has(name)) throw new Error(`dc-tool-manifest: duplicate tool ${name}`);
    entries.set(name, Object.freeze({ name, managed: "unsupported", ...entry }));
  }
  // Every schema must belong to a capability tool and vice versa.
  for (const name of Object.keys(DC_TOOL_ARGUMENT_SCHEMAS)) {
    if (entries.get(name)?.managed !== "capability") {
      throw new Error(`dc-tool-manifest: schema without capability tool ${name}`);
    }
  }
  return entries;
}

const MANIFEST = buildManifest();

/** Every Desktop Commander tool with an explicit managed disposition, sorted by name. */
export function dcToolContracts(): DcToolContract[] {
  return [...MANIFEST.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function dcToolContract(name: string): DcToolContract | undefined {
  return MANIFEST.get(name);
}

/** Tools ACS can authorize through an acs.dc.v1 capability, sorted by name. */
export function dcCapabilityToolContracts(): DcCapabilityToolContract[] {
  return dcToolContracts().filter((entry): entry is DcCapabilityToolContract => entry.managed === "capability");
}

export function dcCapabilityToolContract(name: string): DcCapabilityToolContract | undefined {
  const entry = MANIFEST.get(name);
  return entry?.managed === "capability" ? entry : undefined;
}

/**
 * Transport-only argument metadata. These keys are validated against the
 * allowed values and removed before ACS computes authorization arguments;
 * Desktop Commander applies the identical rule. No other unknown argument key
 * is tolerated: the strict schemas above reject it.
 */
export const DC_TRANSPORT_METADATA_ARGUMENT_KEYS = Object.freeze(["origin"] as const);
export type DcTransportMetadataKey = (typeof DC_TRANSPORT_METADATA_ARGUMENT_KEYS)[number];
export const DC_TRANSPORT_METADATA_VALUES: Readonly<Record<DcTransportMetadataKey, readonly string[]>> = Object.freeze({
  origin: Object.freeze(["ui", "llm"])
});

/**
 * Where the ACS-issued capability envelope travels in MCP `params._meta`.
 * The gateway writes both keys; Desktop Commander's managed guard reads
 * `guard`. Clients may not supply either: the gateway strips every
 * client-supplied key for which `isAcsAuthorityMetaKey` is true before it asks
 * ACS for a capability.
 */
export const DC_CAPABILITY_META_KEYS = Object.freeze({
  gateway: "capability",
  guard: "acsCapability"
} as const);

export function isAcsAuthorityMetaKey(key: string): boolean {
  return key === DC_CAPABILITY_META_KEYS.gateway || key.startsWith("acs");
}

/**
 * Tools Desktop Commander allows WITHOUT a capability in managed mode, for
 * local identity discovery only. A capability presented for them is still
 * verified.
 */
export const DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS = Object.freeze(["get_runtime_identity"] as const);
