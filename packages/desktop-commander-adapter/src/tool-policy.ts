import { z } from "zod";

/**
 * ACS-side Desktop Commander tool allowlist (Phase 2 + Phase 3).
 *
 * Tool discovery (`client.listTools()`) is deliberately separate from tool
 * authorization. A tool is executable ONLY if it appears in this registry with
 * an explicit `argsSchema`. Anything Desktop Commander advertises that is not
 * listed here is denied by default, and a newly added Desktop Commander tool can
 * never become executable just by appearing in `tools/list`.
 */

export type DesktopCommanderRiskClass = "read_only" | "safe_mutation" | "requires_approval" | "destructive";

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

const MAX_PATH_LEN = 4096;
const MAX_TEXT_LEN = 100_000;
const MAX_SMALL_TEXT_LEN = 8_192;

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

const getConfigArgs = z.object({}).strict();

const readFileArgs = z
  .object({
    path: pathString,
    // Network reads are forbidden by ACS policy - `isUrl` may only be false.
    isUrl: z.literal(false).optional(),
    offset: z.number().int().min(0).max(1_000_000_000).optional(),
    length: z.number().int().min(1).max(1_000_000).optional()
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
    depth: z.number().int().min(1).max(8).optional()
  })
  .strict();

const getFileInfoArgs = z.object({ path: pathString }).strict();

const createDirectoryArgs = z.object({ path: pathString }).strict();

const writeFileArgs = z
  .object({
    path: pathString,
    content: z.string().max(MAX_TEXT_LEN),
    mode: z.enum(["rewrite", "append"]).optional()
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
      .max(15 * 60 * 1_000)
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

const searchSessionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, "search session id has an unexpected shape");

const startSearchArgs = z
  .object({
    path: pathString,
    pattern: z.string().min(1).max(MAX_SMALL_TEXT_LEN),
    searchType: z.enum(["files", "content"]).optional(),
    filePattern: z.string().min(1).max(1_024).optional(),
    ignoreCase: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(10_000).optional(),
    includeHidden: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(50).optional(),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(5 * 60 * 1_000)
      .optional(),
    earlyTermination: z.boolean().optional(),
    literalSearch: z.boolean().optional(),
    structured: z.boolean().optional()
  })
  .strict();

const getMoreSearchResultsArgs = z
  .object({
    sessionId: searchSessionId,
    // Desktop Commander semantics: negative offset = tail.
    offset: z.number().int().min(-1_000_000).max(1_000_000_000).optional(),
    length: z.number().int().min(1).max(10_000).optional(),
    structured: z.boolean().optional()
  })
  .strict();

// --- execution-plane tools (Desktop Commander expansion) ---------------------

const shaHex64 = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase sha256 hex digest");
const commitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "must be a full lowercase commit SHA");
const processId = z.number().int().min(1).max(2_147_483_647);
const shortId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@-]+$/u);

const lastErrorArgs = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    tool: shortId.optional(),
    requestId: shortId.optional(),
    correlationId: shortId.optional()
  })
  .strict();
const capabilityManifestArgs = z.object({ tool: shortId.optional() }).strict();
const operationPreviewArgs = z
  .object({ tool: shortId, arguments: z.record(z.string(), z.unknown()).optional() })
  .strict();
const gitStateArgs = z.object({ repoPath: pathString }).strict();
const verifyHeadArgs = z.object({ repoPath: pathString, expectedSha: commitSha }).strict();
const secretScanArgs = z
  .object({
    target: z.enum(["text", "file", "diff"]),
    text: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    path: pathString.optional(),
    patch: z
      .string()
      .max(2 * 1024 * 1024)
      .optional()
  })
  .strict();
const waitForProcessArgs = z
  .object({
    pid: processId,
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 60 * 1_000)
      .optional(),
    until: z
      .object({
        type: z.enum(["exit", "stdout_pattern", "stderr_pattern", "either_pattern"]),
        pattern: z.string().min(1).max(1_000).optional()
      })
      .strict()
      .optional(),
    tailLines: z.number().int().min(0).max(1_000).optional()
  })
  .strict();
const runCommandArgs = z
  .object({
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    cwd: pathString,
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(15 * 60 * 1_000)
      .optional(),
    maxStdoutBytes: z
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024)
      .optional(),
    maxStderrBytes: z
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024)
      .optional(),
    expectedHeadSha: commitSha.optional()
  })
  .strict();
const terminateProcessArgs = z
  .object({ pid: processId, graceMs: z.number().int().min(0).max(30_000).optional(), force: z.boolean().optional() })
  .strict();
const applyPatchArgs = z
  .object({
    path: pathString,
    patch: z
      .string()
      .min(1)
      .max(1024 * 1024),
    expectedSha256: shaHex64,
    expectedHeadSha: commitSha.optional()
  })
  .strict();
const snapshotPathArgs = z.object({ path: pathString, reason: z.string().max(2_000).optional() }).strict();
const restoreSnapshotArgs = z
  .object({
    snapshotId: z.string().regex(/^snap_\d{8}T\d{6}Z_[a-f0-9]{16}$/u),
    expectedCurrentSha256: shaHex64.optional()
  })
  .strict();

function readOnlyPolicy(
  name: string,
  argsSchema: z.ZodTypeAny,
  extra: Partial<DesktopCommanderToolPolicy> = {}
): DesktopCommanderToolPolicy {
  return {
    name,
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema,
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
  argsSchema: z.ZodTypeAny,
  extra: Partial<DesktopCommanderToolPolicy> = {}
): DesktopCommanderToolPolicy {
  return {
    name,
    riskClass: "requires_approval",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema,
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

const policies: readonly DesktopCommanderToolPolicy[] = [
  {
    name: "get_config",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: getConfigArgs,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 128 * 1024
  },
  {
    name: "get_file_info",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: getFileInfoArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "list_directory",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: listDirectoryArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "read_file",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: readFileArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "read_multiple_files",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: readMultipleFilesArgs,
    pathArgs: [],
    multiPathArgs: ["paths"],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "list_sessions",
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
    maxResultBytes: 64 * 1024
  },
  {
    name: "list_processes",
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
    maxResultBytes: 128 * 1024
  },
  {
    name: "read_process_output",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: readProcessOutputArgs,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 5 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "get_usage_stats",
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
    maxResultBytes: 16 * 1024
  },
  {
    name: "start_search",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: startSearchArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 5 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "get_more_search_results",
    riskClass: "read_only",
    mutating: false,
    network: false,
    destructive: false,
    requiresApproval: false,
    argsSchema: getMoreSearchResultsArgs,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 256 * 1024
  },
  {
    name: "list_searches",
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
    maxResultBytes: 64 * 1024
  },
  {
    name: "create_directory",
    riskClass: "safe_mutation",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema: createDirectoryArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 16 * 1024
  },
  {
    name: "write_file",
    riskClass: "requires_approval",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema: writeFileArgs,
    pathArgs: ["path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 32 * 1024
  },
  {
    name: "edit_block",
    riskClass: "requires_approval",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema: editBlockArgs,
    pathArgs: ["file_path"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 60_000,
    maxResultBytes: 64 * 1024
  },
  {
    name: "move_file",
    riskClass: "requires_approval",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema: moveFileArgs,
    pathArgs: ["source", "destination"],
    multiPathArgs: [],
    cwdArgs: [],
    commandArgs: [],
    timeoutMs: 30_000,
    maxResultBytes: 16 * 1024
  },
  {
    name: "start_process",
    riskClass: "requires_approval",
    mutating: true,
    network: false,
    destructive: false,
    requiresApproval: true,
    argsSchema: startProcessArgs,
    pathArgs: [],
    multiPathArgs: [],
    cwdArgs: ["cwd"],
    commandArgs: ["command"],
    timeoutMs: 15 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  },
  readOnlyPolicy("health", emptyArgs),
  readOnlyPolicy("last_error", lastErrorArgs),
  readOnlyPolicy("capability_manifest", capabilityManifestArgs),
  readOnlyPolicy("operation_preview", operationPreviewArgs, { nestedPathContainerArgs: ["arguments"] }),
  readOnlyPolicy("git_state", gitStateArgs, { pathArgs: ["repoPath"] }),
  readOnlyPolicy("verify_head", verifyHeadArgs, { pathArgs: ["repoPath"] }),
  readOnlyPolicy("secret_scan", secretScanArgs, { optionalPathArgs: ["path"] }),
  readOnlyPolicy("wait_for_process", waitForProcessArgs, { timeoutMs: 10 * 60 * 1_000 }),
  approvalPolicy("run_command", runCommandArgs, { cwdArgs: ["cwd"], argvArgs: ["argv"], timeoutMs: 15 * 60 * 1_000 }),
  approvalPolicy("terminate_process", terminateProcessArgs),
  approvalPolicy("apply_patch", applyPatchArgs, { pathArgs: ["path"] }),
  approvalPolicy("snapshot_path", snapshotPathArgs, { pathArgs: ["path"] }),
  approvalPolicy("restore_snapshot", restoreSnapshotArgs)
];

const registry: ReadonlyMap<string, DesktopCommanderToolPolicy> = new Map(
  policies.map((policy) => [policy.name, policy])
);

/**
 * Explicit managed-mode disposition for EVERY tool Desktop Commander registers.
 *
 * `capability`  - executable through ACS capability issuance (policy above).
 * `unsupported` - deterministically denied in managed mode with
 *                 `managed_tool_unsupported` (never `unknown_tool`).
 *
 * The list is pinned against Desktop Commander's own registry by
 * contracts/desktop-commander/managed-tool-coverage.v1.json, which Desktop
 * Commander's test suite also checks; a newly registered DC tool without a
 * disposition fails both repositories' coverage tests.
 */
export type DesktopCommanderToolClass =
  | "read_only"
  | "filesystem_mutation"
  | "process_execution"
  | "process_control"
  | "configuration_mutation"
  | "unsupported";

export interface DesktopCommanderManagedToolDisposition {
  readonly name: string;
  readonly toolClass: DesktopCommanderToolClass;
  readonly managed: "capability" | "unsupported";
  readonly reason: string;
}

const dispositions: readonly DesktopCommanderManagedToolDisposition[] = [
  // read-only (capability, no approval)
  { name: "get_config", toolClass: "read_only", managed: "capability", reason: "configuration read" },
  {
    name: "get_runtime_identity",
    toolClass: "read_only",
    managed: "capability",
    reason: "stable runtime identity + redacted device state; no credentials or decisions"
  },
  { name: "get_file_info", toolClass: "read_only", managed: "capability", reason: "contained path metadata" },
  { name: "list_directory", toolClass: "read_only", managed: "capability", reason: "contained directory listing" },
  {
    name: "read_file",
    toolClass: "read_only",
    managed: "capability",
    reason: "contained file read; URL reads forbidden"
  },
  { name: "read_multiple_files", toolClass: "read_only", managed: "capability", reason: "contained file reads" },
  { name: "start_search", toolClass: "read_only", managed: "capability", reason: "contained ripgrep search session" },
  {
    name: "get_more_search_results",
    toolClass: "read_only",
    managed: "capability",
    reason: "pages an existing search session"
  },
  { name: "list_searches", toolClass: "read_only", managed: "capability", reason: "lists search sessions" },
  { name: "list_sessions", toolClass: "read_only", managed: "capability", reason: "lists DC terminal sessions" },
  { name: "list_processes", toolClass: "read_only", managed: "capability", reason: "process listing" },
  { name: "read_process_output", toolClass: "read_only", managed: "capability", reason: "reads DC session output" },
  { name: "get_usage_stats", toolClass: "read_only", managed: "capability", reason: "DC usage counters" },
  // filesystem mutation (capability + approval)
  {
    name: "create_directory",
    toolClass: "filesystem_mutation",
    managed: "capability",
    reason: "approval-bound mutation"
  },
  { name: "write_file", toolClass: "filesystem_mutation", managed: "capability", reason: "approval-bound mutation" },
  { name: "edit_block", toolClass: "filesystem_mutation", managed: "capability", reason: "approval-bound mutation" },
  { name: "move_file", toolClass: "filesystem_mutation", managed: "capability", reason: "approval-bound mutation" },
  { name: "write_pdf", toolClass: "filesystem_mutation", managed: "unsupported", reason: "no ACS argument schema yet" },
  // process execution
  {
    name: "start_process",
    toolClass: "process_execution",
    managed: "capability",
    reason: "approval-bound; command validated and executable resolved by ACS"
  },
  {
    name: "interact_with_process",
    toolClass: "process_execution",
    managed: "unsupported",
    reason: "free-form input to a live process cannot be bound to a validated command"
  },
  { name: "acpx_list_sessions", toolClass: "process_execution", managed: "unsupported", reason: "spawns the acpx CLI" },
  { name: "acpx_get_session", toolClass: "process_execution", managed: "unsupported", reason: "spawns the acpx CLI" },
  { name: "acpx_exec", toolClass: "process_execution", managed: "unsupported", reason: "arbitrary agent execution" },
  { name: "acpx_prompt", toolClass: "process_execution", managed: "unsupported", reason: "arbitrary agent execution" },
  // process control
  {
    name: "kill_process",
    toolClass: "process_control",
    managed: "unsupported",
    reason: "arbitrary PID signal; not scoped to DC-owned processes"
  },
  {
    name: "force_terminate",
    toolClass: "process_control",
    managed: "unsupported",
    reason: "no ACS argument schema yet"
  },
  {
    name: "stop_search",
    toolClass: "process_control",
    managed: "unsupported",
    reason: "no ACS argument schema yet; searches self-expire"
  },
  { name: "acpx_cancel", toolClass: "process_control", managed: "unsupported", reason: "acpx session control" },
  // configuration mutation
  {
    name: "set_config_value",
    toolClass: "configuration_mutation",
    managed: "unsupported",
    reason: "would let a caller widen DC's own mechanical limits; ACS owns authority"
  },
  // not machine operations
  {
    name: "get_recent_tool_calls",
    toolClass: "unsupported",
    managed: "unsupported",
    reason: "discloses other principals' tool arguments"
  },
  {
    name: "get_prompts",
    toolClass: "unsupported",
    managed: "unsupported",
    reason: "product onboarding prompt injection, not a machine operation"
  },
  {
    name: "give_feedback_to_desktop_commander",
    toolClass: "unsupported",
    managed: "unsupported",
    reason: "opens an external network destination"
  },
  {
    name: "track_ui_event",
    toolClass: "unsupported",
    managed: "unsupported",
    reason: "UI telemetry, not an agent tool"
  },
  { name: "health", toolClass: "read_only", managed: "capability", reason: "degraded-mode-safe status; no secrets" },
  {
    name: "last_error",
    toolClass: "read_only",
    managed: "capability",
    reason: "sanitized diagnostics; arguments as hashes only"
  },
  {
    name: "capability_manifest",
    toolClass: "read_only",
    managed: "capability",
    reason: "mechanical capability; authorization external"
  },
  {
    name: "operation_preview",
    toolClass: "read_only",
    managed: "capability",
    reason: "mechanical preview; nested paths contained by ACS"
  },
  { name: "git_state", toolClass: "read_only", managed: "capability", reason: "contained read-only git inspection" },
  { name: "verify_head", toolClass: "read_only", managed: "capability", reason: "contained HEAD comparison" },
  {
    name: "secret_scan",
    toolClass: "read_only",
    managed: "capability",
    reason: "contained preflight scan; values never returned"
  },
  {
    name: "wait_for_process",
    toolClass: "read_only",
    managed: "capability",
    reason: "observes DC-owned sessions only"
  },
  {
    name: "service_status",
    toolClass: "read_only",
    managed: "unsupported",
    reason: "network probes; ACS defines no network-capable managed Desktop Commander tool"
  },
  {
    name: "run_command",
    toolClass: "process_execution",
    managed: "capability",
    reason: "approval-bound; argv validated by ACS command policy, executable resolved"
  },
  {
    name: "terminate_process",
    toolClass: "process_control",
    managed: "capability",
    reason: "approval-bound; DC-owned sessions only"
  },
  {
    name: "apply_patch",
    toolClass: "filesystem_mutation",
    managed: "capability",
    reason: "approval-bound; hash-guarded atomic write"
  },
  {
    name: "snapshot_path",
    toolClass: "filesystem_mutation",
    managed: "capability",
    reason: "approval-bound; writes the DC snapshot area"
  },
  {
    name: "restore_snapshot",
    toolClass: "filesystem_mutation",
    managed: "capability",
    reason: "approval-bound; restores a sealed DC snapshot"
  }
];

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
