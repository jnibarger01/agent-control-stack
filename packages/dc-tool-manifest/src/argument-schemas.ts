import { z } from "zod";

/**
 * Strict (no unknown keys) argument schemas for every Desktop Commander tool
 * that ACS can authorize through an acs.dc.v1 capability.
 *
 * Moved verbatim from packages/desktop-commander-adapter/src/tool-policy.ts so
 * the tool contract has one canonical home. Consumers must not re-declare these.
 */

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

/** Argument schema per capability tool name. Keys must match the manifest exactly. */
export const DC_TOOL_ARGUMENT_SCHEMAS = Object.freeze({
  get_config: getConfigArgs,
  get_file_info: getFileInfoArgs,
  list_directory: listDirectoryArgs,
  read_file: readFileArgs,
  read_multiple_files: readMultipleFilesArgs,
  list_sessions: emptyArgs,
  list_processes: emptyArgs,
  read_process_output: readProcessOutputArgs,
  get_usage_stats: emptyArgs,
  get_runtime_identity: emptyArgs,
  start_search: startSearchArgs,
  get_more_search_results: getMoreSearchResultsArgs,
  list_searches: emptyArgs,
  create_directory: createDirectoryArgs,
  write_file: writeFileArgs,
  edit_block: editBlockArgs,
  move_file: moveFileArgs,
  start_process: startProcessArgs,
  health: emptyArgs,
  last_error: lastErrorArgs,
  capability_manifest: capabilityManifestArgs,
  operation_preview: operationPreviewArgs,
  git_state: gitStateArgs,
  verify_head: verifyHeadArgs,
  secret_scan: secretScanArgs,
  wait_for_process: waitForProcessArgs,
  run_command: runCommandArgs,
  terminate_process: terminateProcessArgs,
  apply_patch: applyPatchArgs,
  snapshot_path: snapshotPathArgs,
  restore_snapshot: restoreSnapshotArgs
} satisfies Record<string, z.ZodTypeAny>);

export type DcCapabilityToolName = keyof typeof DC_TOOL_ARGUMENT_SCHEMAS;
