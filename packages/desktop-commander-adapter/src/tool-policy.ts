import type { z } from "zod";
import {
  dcCapabilityToolContract,
  dcCapabilityToolContracts,
  dcToolContracts,
  type DcRiskClass,
  type DcToolClass
} from "@agent-control-stack/dc-tool-manifest";

/**
 * ACS-side Desktop Commander tool allowlist (Phase 2 + Phase 3).
 *
 * Tool discovery (`client.listTools()`) is deliberately separate from tool
 * authorization. A tool is executable ONLY if it appears in this registry with
 * an explicit `argsSchema`. Anything Desktop Commander advertises that is not
 * listed here is denied by default, and a newly added Desktop Commander tool can
 * never become executable just by appearing in `tools/list`.
 *
 * The tool contract itself (argument schema, risk class, approval
 * requirement, scope, managed disposition) is owned by
 * @agent-control-stack/dc-tool-manifest (ADR 0019). This file adds only the
 * ACS-side enforcement mechanics: which arguments are paths/commands to
 * contain and canonicalize, and per-call time/result limits.
 */

export type DesktopCommanderRiskClass = DcRiskClass;

export interface DesktopCommanderToolPolicy {
  readonly name: string;
  readonly riskClass: DesktopCommanderRiskClass;
  readonly mutating: boolean;
  readonly network: boolean;
  readonly destructive: boolean;
  readonly requiresApproval: boolean;
  /** Zod schema for the fully-validated argument object (strict; no unknown keys). */
  readonly argsSchema: z.ZodTypeAny;
  /** Argument keys carrying a single filesystem path. */
  readonly pathArgs: readonly string[];
  /** Argument keys carrying an array of filesystem paths. */
  readonly multiPathArgs: readonly string[];
  /** Argument keys carrying a working directory. */
  readonly cwdArgs: readonly string[];
  /** Argument keys carrying a shell command line to be parsed + policy-checked. */
  readonly commandArgs: readonly string[];
  /** Argument keys carrying an OPTIONAL single path (contained + canonicalized when present). */
  readonly optionalPathArgs?: readonly string[];
  /** Argument keys carrying an argv array (validated like a command; argv[0] bound to its resolved executable). */
  readonly argvArgs?: readonly string[];
  /** Argument keys carrying a nested argument object whose path-like keys must be contained (not rewritten). */
  readonly nestedPathContainerArgs?: readonly string[];
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
}

/** ACS enforcement mechanics; the contract fields come from the manifest. */
type DesktopCommanderToolMechanics = Omit<DesktopCommanderToolPolicy, "riskClass" | "requiresApproval" | "argsSchema">;

<<<<<<< Updated upstream
function readOnlyPolicy(
  name: string,
  extra: Partial<DesktopCommanderToolMechanics> = {}
): DesktopCommanderToolMechanics {
  return {
    name,
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024,
    ...extra
  };
}

function approvalPolicy(
  name: string,
  extra: Partial<DesktopCommanderToolMechanics> = {}
): DesktopCommanderToolMechanics {
  return {
    name,
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024,
    ...extra
  };
}

// --- the registry ----------------------------------------------------------

const mechanics: readonly DesktopCommanderToolMechanics[] = [
  {
    name: "get_config",
=======
const pathString = z
  .string()
  .min(1)
  .max(MAX_PATH_LEN)
  .refine((value) => !value.includes("\0"), "path must not contain NUL");

const commandString = z
  .string()
  .min(1)
  .max(MAX_SMALL_TEXT_LEN)
  .refine((value) => !value.includes("\0"), "command must not contain NUL")
  .refine((value) => !/[\r\n]/.test(value), "command must be a single line");

// --- per-tool argument schemas (strict) -------------------------------------

// `origin` is optional telemetry attribution defined by the Desktop Commander
// MCP tool contract (`src/tools/schemas.ts`): 'ui' marks widget-fired calls.
// It is NOT authorization-relevant — no ACS policy, scope, or approval decision
// reads it — but it is a legitimate schema field, so strict parsing must accept
// it. It flows into normalizedArguments and the invocation hash identically on
// issuance and executor verification, so the capability still binds the exact
// invocation the caller sends.
const originArg = z.enum(["ui", "llm"]).optional();

const getConfigArgs = z.object({
  origin: originArg
}).strict();

const readFileArgs = z
  .object({
    path: pathString,
    // Network reads are forbidden by ACS policy - `isUrl` may only be false.
    isUrl: z.literal(false).optional(),
    offset: z.number().int().min(0).max(1_000_000_000).optional(),
    length: z.number().int().min(1).max(1_000_000).optional(),
    origin: originArg
  })
  .strict();

const readMultipleFilesArgs = z
  .object({
    paths: z.array(pathString).min(1).max(64)
  })
  .strict();

const listDirectoryArgs = z
  .object({
    path: pathString,
    depth: z.number().int().min(1).max(8).optional(),
    origin: originArg
  })
  .strict();

const getFileInfoArgs = z.object({ path: pathString, origin: originArg }).strict();

const createDirectoryArgs = z.object({ path: pathString }).strict();

const writeFileArgs = z
  .object({
    path: pathString,
    content: z.string().max(MAX_TEXT_LEN),
    mode: z.enum(["rewrite", "append"]).optional(),
    origin: originArg
  })
  .strict();

const moveFileArgs = z
  .object({
    source: pathString,
    destination: pathString
  })
  .strict();

const editBlockArgs = z
  .object({
    file_path: pathString,
    old_string: z.string().max(MAX_TEXT_LEN),
    new_string: z.string().max(MAX_TEXT_LEN),
    expected_replacements: z.number().int().min(1).max(1_000).optional()
  })
  .strict();

const startProcessArgs = z
  .object({
    command: commandString,
    // ACS always runs a process in an explicit, contained working directory.
    cwd: pathString,
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(15 * 60 * 1_000),
    origin: originArg
  })
  .strict();

const readProcessOutputArgs = z
  .object({
    pid: z.number().int().min(1).max(2_147_483_647),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(5 * 60 * 1_000)
      .optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(1_000_000).optional()
  })
  .strict();

const emptyArgs = z.object({}).strict();

// --- the registry ----------------------------------------------------------

const policies: readonly DesktopCommanderToolPolicy[] = [
  {
    name: "get_config",
    riskClass: "read_only",
>>>>>>> Stashed changes
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 128 * 1024
  },
  {
    // Runtime identity discovery. Read-only metadata (runtime id, version,
    // redacted device-auth state; no tokens or credentials per the DC tool
    // contract). Governed like every other tool so the managed child's
    // capability gate, ACS audit and lease/result accounting all agree.
    name: "get_runtime_identity",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: emptyArgs,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "get_file_info",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "list_directory",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "read_file",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "read_multiple_files",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: ["paths"],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "list_sessions",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024
  },
  {
    name: "list_processes",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 128 * 1024
  },
  {
    name: "read_process_output",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 5 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "get_usage_stats",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "get_runtime_identity",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 16 * 1024
  },
  {
    name: "start_search",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 5 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "get_more_search_results",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "list_searches",
    mutating: false,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024
  },
  {
    name: "create_directory",
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 16 * 1024
  },
  {
    name: "write_file",
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "edit_block",
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: ["file_path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 64 * 1024
  },
  {
    name: "move_file",
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: ["source", "destination"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 16 * 1024
  },
  {
    name: "start_process",
    mutating: true,
    network: false,
    destructive: false,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: ["cwd"],
    commandArgs: ["command"],
    timeoutMs: 15 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  readOnlyPolicy("health"),
  readOnlyPolicy("last_error"),
  readOnlyPolicy("capability_manifest"),
  readOnlyPolicy("operation_preview", { nestedPathContainerArgs: ["arguments"] }),
  readOnlyPolicy("git_state", { pathArgs: ["repoPath"] }),
  readOnlyPolicy("verify_head", { pathArgs: ["repoPath"] }),
  readOnlyPolicy("secret_scan", { optionalPathArgs: ["path"] }),
  readOnlyPolicy("wait_for_process", { timeoutMs: 10 * 60 * 1_000 }),
  approvalPolicy("run_command", { cwdArgs: ["cwd"], argvArgs: ["argv"], timeoutMs: 15 * 60 * 1_000 }),
  approvalPolicy("terminate_process"),
  approvalPolicy("apply_patch", { pathArgs: ["path"] }),
  approvalPolicy("snapshot_path", { pathArgs: ["path"] }),
  approvalPolicy("restore_snapshot")
];

/** Join ACS mechanics with the canonical contract; a tool missing from either side fails at load. */
function withContract(entry: DesktopCommanderToolMechanics): DesktopCommanderToolPolicy {
  const contract = dcCapabilityToolContract(entry.name);
  if (!contract) throw new Error(`desktop-commander tool ${entry.name} has no capability contract`);
  return Object.freeze({
    ...entry,
    riskClass: contract.riskClass,
    requiresApproval: contract.requiresApproval,
    argsSchema: contract.argsSchema
  });
}

const registry: ReadonlyMap<string, DesktopCommanderToolPolicy> = new Map(
  mechanics.map((entry) => [entry.name, withContract(entry)])
);
for (const contract of dcCapabilityToolContracts()) {
  if (!registry.has(contract.name)) {
    throw new Error(`desktop-commander capability tool ${contract.name} has no ACS enforcement mechanics`);
  }
}

/**
 * Explicit managed-mode disposition for EVERY tool Desktop Commander registers.
 *
 * `capability`  - executable through ACS capability issuance (policy above).
 * `unsupported` - deterministically denied in managed mode with
 *                 `managed_tool_unsupported` (never `unknown_tool`).
 *
 * Derived from @agent-control-stack/dc-tool-manifest. Desktop Commander's own
 * registry is pinned against it by the generated
 * contracts/desktop-commander/managed-tool-coverage.v1.json and the root drift
 * test; a newly registered DC tool without a disposition fails CI.
 */
export type DesktopCommanderToolClass = DcToolClass;

export interface DesktopCommanderManagedToolDisposition {
  readonly name: string;
  readonly toolClass: DesktopCommanderToolClass;
  readonly managed: "capability" | "unsupported";
  readonly reason: string;
}

const dispositions: readonly DesktopCommanderManagedToolDisposition[] = dcToolContracts().map(
  ({ name, toolClass, managed, reason }) => ({ name, toolClass, managed, reason })
);

const dispositionRegistry: ReadonlyMap<string, DesktopCommanderManagedToolDisposition> = new Map(
  dispositions.map((entry) => [entry.name, Object.freeze(entry)])
);

export function desktopCommanderManagedToolDisposition(
  name: string
): DesktopCommanderManagedToolDisposition | undefined {
  return dispositionRegistry.get(name);
}

export function desktopCommanderManagedToolDispositions(): DesktopCommanderManagedToolDisposition[] {
  return [...dispositionRegistry.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function desktopCommanderToolPolicy(name: string): DesktopCommanderToolPolicy | undefined {
  return registry.get(name);
}

export function isAllowlistedDesktopCommanderTool(name: string): boolean {
  return registry.has(name);
}

export function allowlistedDesktopCommanderToolNames(): string[] {
  return [...registry.keys()].sort();
}
