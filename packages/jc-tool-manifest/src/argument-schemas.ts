import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

/**
 * Strict per-tool argument schemas for the Jace Commander (`acs.jc.v1`) tool
 * surface. Canonical source: this file. Both ACS
 * (`packages/desktop-commander-adapter`) and Jace Commander itself
 * (`vendor/desktop-commander/src/jace-commander`) must validate identical
 * shapes; the root drift test enforces it.
 *
 * Unknown keys are rejected (`z.strictObject`). No defaults or coercion:
 * whatever the caller sends is exactly what gets hashed and signed.
 */

const ID = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const ABSOLUTE = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"), "must be an absolute path");

/** Upper bounds shared by schema validation and the JC runtime's own output caps. */
export const JC_FS_LIMITS = Object.freeze({
  /** Max lines one read_file call may return. */
  maxReadLines: 10_000,
  /** Largest positive line offset; negative offsets read from the end (tail). */
  maxReadOffset: 10_000_000,
  /** Max files one read_multiple_files call may read. */
  maxMultipleFiles: 20,
  /** Max recursion depth for list_directory. */
  maxListDepth: 5,
  /** Max entries list_directory returns before truncating. */
  maxListEntries: 2_000
});

export const JC_TOOL_NAMES = Object.freeze([
  "jc_status",
  "acs_read",
  "acs_submit_mission",
  "swarm_read",
  "visualizer_read",
  "mission_router_list",
  "looptrace_verify",
  "privileged_exec",
  "list_directory",
  "get_file_info",
  "read_file",
  "read_multiple_files",
  "start_search",
  "get_more_search_results",
  "list_searches",
  "stop_search",
  "write_file",
  "create_directory",
  "move_file",
  "edit_block",
  "start_process",
  "read_process_output",
  "list_sessions",
  "kill_process",
  "list_processes",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_show",
  "git_add",
  "git_commit",
  "git_fetch",
  "git_push",
  "jc_doctor",
  "ping",
  "get_config"
] as const);
export type JcToolName = (typeof JC_TOOL_NAMES)[number];

export const JC_TOOL_ARGUMENT_SCHEMAS: Readonly<Record<JcToolName, z.ZodType>> = Object.freeze({
  jc_status: z.strictObject({}),
  acs_read: z.strictObject({
    view: z.enum(["health", "work-items", "work-item"]),
    id: ID.optional(),
    status: z.string().min(1).max(64).optional()
  }),
  acs_submit_mission: z.strictObject({
    title: z.string().min(1).max(200),
    intent: z.string().min(1).max(8000),
    target: z.record(z.string(), z.unknown()),
    requestedActions: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
    risk: z.enum(["low", "medium", "high", "critical"]).optional(),
    correlationId: ID.optional()
  }),
  swarm_read: z.strictObject({
    view: z.enum(["health", "mission-control", "runs", "status", "task"]),
    taskId: ID.optional()
  }),
  visualizer_read: z.strictObject({
    view: z.enum(["system-status", "runtimes", "executions", "approvals", "alerts", "agents"])
  }),
  mission_router_list: z.strictObject({}),
  looptrace_verify: z.strictObject({ path: ABSOLUTE }),
  privileged_exec: z.strictObject({
    argv: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0"), "argv entries must not contain NUL")
      )
      .min(1)
      .max(256)
      .refine(
        (argv) => isAbsolute(argv[0]!) && normalize(argv[0]!) === argv[0],
        "argv[0] must be a normalized absolute path"
      ),
    cwd: ABSOLUTE.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    stdin: z
      .string()
      .max(64 * 1024)
      .optional()
  }),
  // Filesystem (read-only, fs.read). Paths must already be absolute: the
  // caller (CLI or MCP client) resolves `~` and relative paths before the
  // call, so the exact string ACS signs is the exact string JC contains and
  // reads. ACS and JC both check containment; neither trusts the other.
  list_directory: z.strictObject({
    path: ABSOLUTE,
    depth: z.number().int().min(1).max(JC_FS_LIMITS.maxListDepth).optional()
  }),
  get_file_info: z.strictObject({ path: ABSOLUTE }),
  read_file: z.strictObject({
    path: ABSOLUTE,
    offset: z.number().int().min(-JC_FS_LIMITS.maxReadOffset).max(JC_FS_LIMITS.maxReadOffset).optional(),
    length: z.number().int().min(1).max(JC_FS_LIMITS.maxReadLines).optional()
  }),
  read_multiple_files: z.strictObject({
    paths: z.array(ABSOLUTE).min(1).max(JC_FS_LIMITS.maxMultipleFiles)
  }),
  start_search: z.strictObject({
    path: ABSOLUTE,
    pattern: z.string().min(1).max(256),
    mode: z.enum(["filename", "content"]),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    fileFilter: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  get_more_search_results: z.strictObject({
    searchId: ID,
    limit: z.number().int().min(1).max(100).optional()
  }),
  list_searches: z.strictObject({}),
  stop_search: z.strictObject({ searchId: ID }),
  write_file: z.strictObject({
    path: ABSOLUTE,
    content: z.string().max(256 * 1024),
    overwrite: z.boolean().optional()
  }),
  create_directory: z.strictObject({ path: ABSOLUTE, recursive: z.boolean().optional() }),
  move_file: z.strictObject({ from: ABSOLUTE, to: ABSOLUTE }),
  edit_block: z.strictObject({
    path: ABSOLUTE,
    old: z.string().min(1).max(8192),
    new: z.string().max(8192)
  }),
  start_process: z.strictObject({
    argv: z.array(z.string().min(1).max(1024)).min(1).max(32),
    cwd: ABSOLUTE,
    timeoutMs: z.number().int().min(1).max(600_000).optional()
  }),
  read_process_output: z.strictObject({
    sessionId: ID,
    offset: z.number().int().min(0).optional()
  }),
  list_sessions: z.strictObject({}),
  list_processes: z.strictObject({}),
  kill_process: z.strictObject({ sessionId: ID.optional(), pid: z.number().int().positive().optional() }),
  git_status: z.strictObject({ repo: ABSOLUTE }),
  git_diff: z.strictObject({
    repo: ABSOLUTE,
    staged: z.boolean().optional(),
    path: z.string().min(1).max(1024).optional()
  }),
  git_log: z.strictObject({ repo: ABSOLUTE, limit: z.number().int().min(1).max(100).optional() }),
  git_branch: z.strictObject({ repo: ABSOLUTE }),
  git_show: z.strictObject({
    repo: ABSOLUTE,
    rev: z.union([z.literal("HEAD"), z.string().regex(/^[a-f0-9]{40}$/u)]).optional()
  }),
  git_add: z.strictObject({ repo: ABSOLUTE, paths: z.array(z.string().min(1).max(1024)).min(1).max(50) }),
  git_commit: z.strictObject({ repo: ABSOLUTE, message: z.string().min(1).max(500) }),
  git_fetch: z.strictObject({ repo: ABSOLUTE, remote: z.string().min(1).max(128).optional() }),
  git_push: z.strictObject({
    repo: ABSOLUTE,
    remote: z.string().min(1).max(128).optional(),
    branch: z.string().min(1).max(128).optional()
  }),
  jc_doctor: z.strictObject({}),
  ping: z.strictObject({}),
  get_config: z.strictObject({})
});
