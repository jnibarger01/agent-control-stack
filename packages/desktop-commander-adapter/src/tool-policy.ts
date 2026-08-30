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
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
}

const MAX_PATH_LEN = 4096;
const MAX_TEXT_LEN = 1_000_000;
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
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(15 * 60 * 1_000),
    shell: z.string().min(1).max(256).optional()
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
    riskClass: "destructive",
    mutating: true,
    network: false,
    destructive: true,
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
    cwdArgs: [],
    commandArgs: ["command"],
    timeoutMs: 15 * 60 * 1_000,
    maxResultBytes: 256 * 1024
  }
];

const registry: ReadonlyMap<string, DesktopCommanderToolPolicy> = new Map(
  policies.map((policy) => [policy.name, policy])
);

export function desktopCommanderToolPolicy(name: string): DesktopCommanderToolPolicy | undefined {
  return registry.get(name);
}

export function isAllowlistedDesktopCommanderTool(name: string): boolean {
  return registry.has(name);
}

export function allowlistedDesktopCommanderToolNames(): string[] {
  return [...registry.keys()].sort();
}
