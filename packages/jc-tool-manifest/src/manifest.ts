import type { z } from "zod";
import { createHash } from "node:crypto";
import { JC_FS_LIMITS, JC_TOOL_ARGUMENT_SCHEMAS, JC_TOOL_NAMES, type JcToolName } from "./argument-schemas.js";

/**
 * Canonical Jace Commander tool contract for ACS-managed execution
 * (docs/jace-commander.md, docs/protocol/acs-jc-v1-capability-contract.md).
 *
 * This is the ONE authoritative definition of:
 *  - which Jace Commander tools exist,
 *  - the acs.jc.v1 scope(s) each tool requires,
 *  - the policy-gate action kind and risk class ACS evaluates,
 *  - whether ACS requires a recorded human approval before issuing a capability,
 *  - the strict argument schema ACS validates before signing,
 *  - the MCP `inputSchema` Jace Commander itself advertises via tools/list.
 *
 * ACS (packages/desktop-commander-adapter) imports this directly. Jace
 * Commander (vendor/desktop-commander/src/jace-commander) keeps an in-process
 * copy because it is built outside the npm workspace graph (same reason
 * Desktop Commander keeps its own copy of @agent-control-stack/dc-tool-manifest's
 * data) — the root drift test fails when the two disagree.
 *
 * Nothing here is an authorization decision by itself: a capability still has
 * to be a per-call, ACS-signed acs.jc.v1 envelope that Jace Commander's own
 * verifier checks before anything runs.
 */

export const JC_CAPABILITY_VERSION = "acs.jc.v1" as const;
export const JC_AUDIENCE = "jace-commander" as const;
export const JC_INVOCATION_DOMAIN = "acs:jace-commander-invocation:v1";

/** The complete acs.jc.v1 scope vocabulary (issuer and verifier must agree). */
export const JC_SCOPES = Object.freeze([
  "fs.read",
  "fs.write",
  "integration.read",
  "integration.write",
  "process.read",
  "process.exec",
  "process.privileged",
  "git.read",
  "git.write",
  "git.network"
] as const);
export type JcScope = (typeof JC_SCOPES)[number];

/** Policy-gate action kinds this tool surface can produce (packages/policy-gate/src/rules.ts). */
export const JC_ACTION_KINDS = Object.freeze([
  "jc.integration.read",
  "jc.integration.write",
  "jc.fs.read",
  "jc.fs.write",
  "jc.process.read",
  "jc.process.exec",
  "jc.git.read",
  "jc.git.write",
  "jc.git.network",
  "privileged.exec"
] as const);
export type JcActionKind = (typeof JC_ACTION_KINDS)[number];

export type JcRiskClass = "low" | "medium" | "critical";

/** Capability group; drives `jace-commander --help` sections and docs. */
export const JC_TOOL_GROUPS = Object.freeze([
  "system",
  "filesystem",
  "search",
  "process",
  "git",
  "acs",
  "mission",
  "swarm",
  "visualizer",
  "privileged"
] as const);
export type JcToolGroup = (typeof JC_TOOL_GROUPS)[number];

export interface JcToolContract {
  readonly name: JcToolName;
  readonly description: string;
  /** MCP tools/list inputSchema (JSON Schema), what Jace Commander itself advertises. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly scopes: readonly JcScope[];
  readonly actionKind: JcActionKind;
  readonly risk: JcRiskClass;
  /** ACS requires a recorded human approval before it will issue a capability. */
  readonly requiresApproval: boolean;
  /** Strict argument schema; unknown keys are rejected. */
  readonly argsSchema: z.ZodTypeAny;
  readonly reason: string;
  readonly group: JcToolGroup;
  /**
   * Arguments holding filesystem paths that ACS itself must contain to its
   * configured Jace Commander roots before issuing a capability (a string
   * argument, or an array of strings). Jace Commander contains them again at
   * execution time against its own roots. Empty: no ACS path containment.
   */
  readonly pathArguments: readonly string[];
  /** `jace-commander` CLI verbs that invoke this tool (empty: MCP only). */
  readonly cliCommands: readonly string[];
}

type ToolRow = Omit<JcToolContract, "name" | "argsSchema" | "group" | "pathArguments" | "cliCommands">;
type SurfaceRow = Pick<JcToolContract, "group" | "pathArguments" | "cliCommands">;

function row(
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  scopes: readonly JcScope[],
  actionKind: JcActionKind,
  risk: JcRiskClass,
  requiresApproval: boolean,
  reason: string
): ToolRow {
  return { description, inputSchema, scopes, actionKind, risk, requiresApproval, reason };
}

const str = (description: string) => ({ type: "string", description });

const TOOL_ROWS: Readonly<Record<JcToolName, ToolRow>> = {
  jc_status: row(
    "Report Jace Commander mode, configured endpoints, reachability of ACS / codex-swarm / visualizer, and whether the privileged helper is installed.",
    { type: "object", properties: {}, additionalProperties: false },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only self-diagnostic; no secrets"
  ),
  acs_read: row(
    "Read from the Agent Control Stack gateway: health, work-items (optionally by status), or one work-item with its events, attempts and leases.",
    {
      type: "object",
      properties: {
        view: { type: "string", enum: ["health", "work-items", "work-item"] },
        id: str("Work item id (view=work-item)"),
        status: str("Status filter (view=work-items)")
      },
      required: ["view"],
      additionalProperties: false
    },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only ACS view; fixed allowlist, no upstream path passthrough"
  ),
  acs_submit_mission: row(
    "Submit a mission to ACS as a governed work item. ACS policy decides allow / deny / require_approval; nothing executes here.",
    {
      type: "object",
      properties: {
        title: str("Short title"),
        intent: str("What should happen and why"),
        target: { type: "object", description: "ACS target {repo?, cwd?, files?, services?}" },
        requestedActions: { type: "array", items: { type: "object" } },
        risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
        correlationId: str("Caller correlation id")
      },
      required: ["title", "intent", "target"],
      additionalProperties: false
    },
    ["integration.write"],
    "jc.integration.write",
    "low",
    false,
    "creates a work item; ACS policy is the actual gate, not this call"
  ),
  swarm_read: row(
    "Read-only codex-swarm views: health, mission-control, runs, status (by taskId), task (by taskId).",
    {
      type: "object",
      properties: {
        view: { type: "string", enum: ["health", "mission-control", "runs", "status", "task"] },
        taskId: str("codex-swarm task id")
      },
      required: ["view"],
      additionalProperties: false
    },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only, fixed view allowlist"
  ),
  visualizer_read: row(
    "Read-only Agent Workflow Visualizer views (loopback, same OS user): system-status, runtimes, executions, approvals, alerts, agents.",
    {
      type: "object",
      properties: {
        view: { type: "string", enum: ["system-status", "runtimes", "executions", "approvals", "alerts", "agents"] }
      },
      required: ["view"],
      additionalProperties: false
    },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only, fixed view allowlist, loopback only"
  ),
  mission_router_list: row(
    "List retired Mission Router local state (~/.mission-router): mission ids/states only, plus LoopTrace chain verification of its JSONL audit files.",
    { type: "object", properties: {}, additionalProperties: false },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; mission goals are never returned"
  ),
  looptrace_verify: row(
    "Verify a LoopTrace JSONL hash chain under an allowed trace root. Returns event count and the first tamper point, if any.",
    {
      type: "object",
      properties: { path: str("Absolute path to a .jsonl trace") },
      required: ["path"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; contained to allowed trace roots"
  ),
  privileged_exec: row(
    "Run ONE exact command as root via the jc-privileged-helper. Requires an ACS acs.jc.v1 capability carrying a human approvalId bound to this exact argv/cwd/timeoutMs/stdin. The first call returns an ACS approval challenge (workItemId, actionHash, argv); after a human approves it in ACS, retry the identical call. Each approval authorizes one run. No shell: argv[0] must be an absolute path.",
    {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1 },
        cwd: str("Absolute working directory (default /)"),
        timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
        stdin: str("Optional stdin (<= 64 KiB)")
      },
      required: ["argv"],
      additionalProperties: false
    },
    ["process.privileged"],
    "privileged.exec",
    "critical",
    true,
    "root execution; approval is re-verified by a root-owned helper, not this process"
  ),
  list_directory: row(
    "List a directory under an allowed filesystem root. Returns structured entries (name, relative path, type, size), recursing up to `depth` levels (default 1, max 5). Output is capped; `truncated` reports when entries were omitted.",
    {
      type: "object",
      properties: {
        path: str("Absolute directory path"),
        depth: {
          type: "integer",
          minimum: 1,
          maximum: JC_FS_LIMITS.maxListDepth,
          description: "Recursion depth (default 1)"
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; contained to allowed roots by ACS and again by Jace Commander"
  ),
  get_file_info: row(
    "Return metadata for one file or directory under an allowed filesystem root: type, size, timestamps, permissions and, for text files, line count.",
    { type: "object", properties: { path: str("Absolute path") }, required: ["path"], additionalProperties: false },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only metadata; contained to allowed roots"
  ),
  read_file: row(
    "Read a file under an allowed filesystem root. Text is returned by line window: `offset` is the 0-based start line (negative reads from the end), `length` the max lines (default 1000, max 10000). Returns content plus totalLines and whether more remains.",
    {
      type: "object",
      properties: {
        path: str("Absolute file path"),
        offset: { type: "integer", description: "Start line (0-based); negative reads the last N lines" },
        length: { type: "integer", minimum: 1, maximum: JC_FS_LIMITS.maxReadLines, description: "Max lines to return" }
      },
      required: ["path"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; contained to allowed roots; bounded output"
  ),
  read_multiple_files: row(
    "Read up to 20 files under allowed filesystem roots in one call. Each result reports its own success or error; one failure does not fail the others.",
    {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: JC_FS_LIMITS.maxMultipleFiles }
      },
      required: ["paths"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; every path contained to allowed roots; bounded output"
  ),
  start_search: row(
    "Search filenames or file contents under an allowed root. Returns the first page of bounded hits and a searchId for further pages. Skips node_modules, .git, and symlinks.",
    {
      type: "object",
      properties: {
        path: str("Absolute directory to search"),
        pattern: str("Literal text, or a regular expression when regex is true"),
        mode: { type: "string", enum: ["filename", "content"] },
        regex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        fileFilter: str("Basename glob, for example *.ts"),
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["path", "pattern", "mode"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only; contained to allowed roots; bounded scan and output"
  ),
  get_more_search_results: row(
    "Return the next page of a search started by start_search.",
    {
      type: "object",
      properties: {
        searchId: str("Search id returned by start_search"),
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["searchId"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only page of an existing bounded search"
  ),
  list_searches: row(
    "List in-process searches and whether each is done, truncated, or cancelled. Does not return hit contents.",
    { type: "object", properties: {}, additionalProperties: false },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "read-only search metadata"
  ),
  stop_search: row(
    "Cancel a search. Further pages return no new hits.",
    {
      type: "object",
      properties: { searchId: str("Search id returned by start_search") },
      required: ["searchId"],
      additionalProperties: false
    },
    ["fs.read"],
    "jc.fs.read",
    "low",
    false,
    "cancels a local search; no filesystem mutation"
  ),
  write_file: row(
    "Write a UTF-8 file under an allowed root. Existing files are replaced only when overwrite is true. Symlinks are refused.",
    {
      type: "object",
      properties: {
        path: str("Absolute file path"),
        content: str("File contents, at most 256 KiB"),
        overwrite: { type: "boolean" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    ["fs.write"],
    "jc.fs.write",
    "medium",
    true,
    "mutation; human approval required; contained"
  ),
  create_directory: row(
    "Create a directory under an allowed root.",
    {
      type: "object",
      properties: { path: str("Absolute directory path"), recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false
    },
    ["fs.write"],
    "jc.fs.write",
    "medium",
    true,
    "mutation; human approval required; contained"
  ),
  move_file: row(
    "Rename a file or directory inside allowed roots. Does not overwrite.",
    {
      type: "object",
      properties: { from: str("Absolute source"), to: str("Absolute destination") },
      required: ["from", "to"],
      additionalProperties: false
    },
    ["fs.write"],
    "jc.fs.write",
    "medium",
    true,
    "mutation; human approval required; both paths contained"
  ),
  edit_block: row(
    "Replace one exact occurrence of old text in a file under an allowed root.",
    {
      type: "object",
      properties: {
        path: str("Absolute file"),
        old: str("Text to replace, exactly once"),
        new: str("Replacement text")
      },
      required: ["path", "old", "new"],
      additionalProperties: false
    },
    ["fs.write"],
    "jc.fs.write",
    "medium",
    true,
    "mutation; human approval required; contained"
  ),
  start_process: row(
    "Start one executable with an argv array and a contained cwd. Shells and sudo are refused.",
    {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
        cwd: str("Absolute working directory"),
        timeoutMs: { type: "integer", minimum: 1, maximum: 600000 }
      },
      required: ["argv", "cwd"],
      additionalProperties: false
    },
    ["process.exec"],
    "jc.process.exec",
    "medium",
    true,
    "execution; human approval required; no shell"
  ),
  read_process_output: row(
    "Read buffered stdout and stderr for a process this server started.",
    {
      type: "object",
      properties: { sessionId: str("Session id"), offset: { type: "integer", minimum: 0 } },
      required: ["sessionId"],
      additionalProperties: false
    },
    ["process.read"],
    "jc.process.read",
    "low",
    false,
    "read-only output of a managed process"
  ),
  list_sessions: row(
    "List processes this server started.",
    { type: "object", properties: {}, additionalProperties: false },
    ["process.read"],
    "jc.process.read",
    "low",
    false,
    "read-only"
  ),
  list_processes: row(
    "List processes this server started, including exit codes.",
    { type: "object", properties: {}, additionalProperties: false },
    ["process.read"],
    "jc.process.read",
    "low",
    false,
    "read-only"
  ),
  kill_process: row(
    "Terminate a process this server started.",
    {
      type: "object",
      properties: { sessionId: str("Session id"), pid: { type: "integer" } },
      additionalProperties: false
    },
    ["process.exec"],
    "jc.process.exec",
    "medium",
    true,
    "termination of a managed process; human approval required"
  ),
  git_status: row(
    "Structured git status for a repository inside an allowed root.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree") },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.read"],
    "jc.git.read",
    "low",
    false,
    "read-only git"
  ),
  git_diff: row(
    "git diff for a contained repository. Optional path is relative.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree"), staged: { type: "boolean" }, path: str("Relative path") },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.read"],
    "jc.git.read",
    "low",
    false,
    "read-only git"
  ),
  git_log: row(
    "Recent commits as sha and subject.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree"), limit: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.read"],
    "jc.git.read",
    "low",
    false,
    "read-only git"
  ),
  git_branch: row(
    "Local branch names.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree") },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.read"],
    "jc.git.read",
    "low",
    false,
    "read-only git"
  ),
  git_show: row(
    "Show HEAD or one full commit SHA.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree"), rev: str("HEAD or 40-hex sha") },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.read"],
    "jc.git.read",
    "low",
    false,
    "read-only git"
  ),
  git_add: row(
    "Stage explicit relative paths. Does not stage everything.",
    {
      type: "object",
      properties: {
        repo: str("Absolute git working tree"),
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 }
      },
      required: ["repo", "paths"],
      additionalProperties: false
    },
    ["git.write"],
    "jc.git.write",
    "medium",
    true,
    "stages named paths only; human approval required"
  ),
  git_commit: row(
    "Commit whatever is already staged. Does not run git add.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree"), message: str("Commit message") },
      required: ["repo", "message"],
      additionalProperties: false
    },
    ["git.write"],
    "jc.git.write",
    "medium",
    true,
    "creates a commit; human approval required"
  ),
  git_fetch: row(
    "Fetch one named remote. Does not merge.",
    {
      type: "object",
      properties: { repo: str("Absolute git working tree"), remote: str("Remote name") },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.network"],
    "jc.git.network",
    "medium",
    true,
    "network read of a remote; human approval required"
  ),
  git_push: row(
    "Push the current branch to a remote. Detached HEAD and force push are refused.",
    {
      type: "object",
      properties: {
        repo: str("Absolute git working tree"),
        remote: str("Remote name"),
        branch: str("Must match the current branch")
      },
      required: ["repo"],
      additionalProperties: false
    },
    ["git.network"],
    "jc.git.network",
    "medium",
    true,
    "updates a remote branch; human approval required; no force"
  ),
  jc_doctor: row(
    "Report JC version, manifest size, filesystem roots, ACS reachability, git, and whether this process looks like a legacy checkout. No secrets.",
    { type: "object", properties: {}, additionalProperties: false },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only diagnosis"
  ),
  ping: row(
    "Liveness plus a short ACS /health probe.",
    { type: "object", properties: {}, additionalProperties: false },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only"
  ),
  get_config: row(
    "Non-secret JC configuration: urls, roots, tool count, manifest hash.",
    { type: "object", properties: {}, additionalProperties: false },
    ["integration.read"],
    "jc.integration.read",
    "low",
    false,
    "read-only; tokens are omitted"
  )
};

const surface = (group: JcToolGroup, pathArguments: readonly string[], cliCommands: readonly string[]): SurfaceRow => ({
  group,
  pathArguments,
  cliCommands
});

/**
 * Grouping, ACS path containment and CLI verbs per tool. The CLI verbs here
 * are the contract the `jace-commander` command table must implement; the
 * root drift test fails if either side has a verb the other lacks.
 */
const TOOL_SURFACE: Readonly<Record<JcToolName, SurfaceRow>> = {
  jc_status: surface("system", [], ["status"]),
  acs_read: surface("acs", [], ["acs read"]),
  acs_submit_mission: surface("acs", [], ["acs submit"]),
  swarm_read: surface("swarm", [], ["swarm read"]),
  visualizer_read: surface("visualizer", [], ["visualizer read"]),
  mission_router_list: surface("mission", [], ["mission list"]),
  // LoopTrace paths are contained by Jace Commander to its trace roots; ACS
  // has no view of those roots, so it does not contain them (unchanged).
  looptrace_verify: surface("mission", [], ["looptrace verify"]),
  privileged_exec: surface("privileged", [], ["sudo"]),
  list_directory: surface("filesystem", ["path"], ["ls"]),
  get_file_info: surface("filesystem", ["path"], ["stat"]),
  read_file: surface("filesystem", ["path"], ["read", "cat"]),
  read_multiple_files: surface("filesystem", ["paths"], []),
  start_search: surface("search", ["path"], ["search"]),
  get_more_search_results: surface("search", [], ["search-results"]),
  list_searches: surface("search", [], ["search-status"]),
  stop_search: surface("search", [], ["search-stop"]),
  write_file: surface("filesystem", ["path"], ["write"]),
  create_directory: surface("filesystem", ["path"], ["mkdir"]),
  move_file: surface("filesystem", ["from", "to"], ["mv"]),
  edit_block: surface("filesystem", ["path"], ["edit"]),
  start_process: surface("process", ["cwd"], ["start"]),
  read_process_output: surface("process", [], ["output"]),
  list_sessions: surface("process", [], ["sessions"]),
  list_processes: surface("process", [], ["ps"]),
  kill_process: surface("process", [], ["kill"]),
  git_status: surface("git", ["repo"], ["git status"]),
  git_diff: surface("git", ["repo"], ["git diff"]),
  git_log: surface("git", ["repo"], ["git log"]),
  git_branch: surface("git", ["repo"], ["git branch"]),
  git_show: surface("git", ["repo"], ["git show"]),
  git_add: surface("git", ["repo"], ["git add"]),
  git_commit: surface("git", ["repo"], ["git commit"]),
  git_fetch: surface("git", ["repo"], ["git fetch"]),
  git_push: surface("git", ["repo"], ["git push"]),
  jc_doctor: surface("system", [], ["doctor"]),
  ping: surface("system", [], ["ping"]),
  get_config: surface("system", [], ["config"])
};

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function buildManifest(): ReadonlyMap<JcToolName, JcToolContract> {
  const entries = new Map<JcToolName, JcToolContract>();
  const verbs = new Set<string>();
  for (const name of JC_TOOL_NAMES) {
    const source = TOOL_ROWS[name];
    const entry = Object.freeze({
      name,
      argsSchema: JC_TOOL_ARGUMENT_SCHEMAS[name],
      ...source,
      inputSchema: deepFreezeJson(source.inputSchema),
      // Do not expose TOOL_ROWS' mutable array through the public contract.
      // Policy consumers retain these objects for the process lifetime, so
      // nested policy values must be immutable too.
      scopes: Object.freeze([...source.scopes]),
      ...TOOL_SURFACE[name]
    });
    for (const arg of entry.pathArguments) {
      const properties = entry.inputSchema.properties as Record<string, unknown> | undefined;
      if (!properties || !(arg in properties))
        throw new Error(`jc-tool-manifest: ${name} pathArgument ${arg} is not a declared argument`);
    }
    for (const verb of entry.cliCommands) {
      if (verbs.has(verb)) throw new Error(`jc-tool-manifest: CLI verb "${verb}" mapped to two tools`);
      verbs.add(verb);
    }
    entries.set(name, entry);
  }
  return entries;
}

const MANIFEST = buildManifest();

/** Every Jace Commander tool contract, sorted by name. */
export function jcToolContracts(): JcToolContract[] {
  return [...MANIFEST.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function jcToolContract(name: string): JcToolContract | undefined {
  return MANIFEST.get(name as JcToolName);
}

export function jcToolNames(): JcToolName[] {
  return jcToolContracts().map((entry) => entry.name);
}

/** The MCP `tools/list` shape Jace Commander itself advertises for every tool. */
export function jcMcpToolDescriptors(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return jcToolContracts().map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: { ...inputSchema }
  }));
}

/** JSON-safe projection of one tool: everything except the zod schema. */
export interface JcPortableToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly scopes: readonly JcScope[];
  readonly actionKind: JcActionKind;
  readonly risk: JcRiskClass;
  readonly requiresApproval: boolean;
  readonly group: JcToolGroup;
  readonly pathArguments: readonly string[];
  readonly cliCommands: readonly string[];
}

export interface JcPortableManifest {
  readonly version: typeof JC_CAPABILITY_VERSION;
  /** sha256 over the canonical JSON of `tools`; changes whenever any tool contract changes. */
  readonly manifestHash: string;
  readonly scopes: readonly JcScope[];
  readonly tools: readonly JcPortableToolContract[];
}

/**
 * The manifest as data Jace Commander embeds (it cannot import this package:
 * vendor/desktop-commander is built outside the npm workspace graph).
 * scripts/jc-tool-manifest.ts writes it to
 * vendor/desktop-commander/src/jace-commander/manifest.generated.ts.
 */
export function jcPortableManifest(): JcPortableManifest {
  const tools = jcToolContracts().map(
    ({
      name,
      description,
      inputSchema,
      scopes,
      actionKind,
      risk,
      requiresApproval,
      group,
      pathArguments,
      cliCommands
    }) => ({
      name,
      description,
      inputSchema: JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>,
      scopes: [...scopes],
      actionKind,
      risk,
      requiresApproval,
      group,
      pathArguments: [...pathArguments],
      cliCommands: [...cliCommands]
    })
  );
  const manifestHash = createHash("sha256").update(JSON.stringify(tools), "utf8").digest("hex");
  return { version: JC_CAPABILITY_VERSION, manifestHash, scopes: [...JC_SCOPES], tools };
}
