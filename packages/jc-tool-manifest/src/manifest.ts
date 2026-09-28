import type { z } from "zod";
import { JC_TOOL_ARGUMENT_SCHEMAS, JC_TOOL_NAMES, type JcToolName } from "./argument-schemas.js";

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
  "integration.read",
  "integration.write",
  "process.privileged"
] as const);
export type JcScope = (typeof JC_SCOPES)[number];

/** Policy-gate action kinds this tool surface can produce (packages/policy-gate/src/rules.ts). */
export const JC_ACTION_KINDS = Object.freeze([
  "jc.integration.read",
  "jc.integration.write",
  "jc.fs.read",
  "privileged.exec"
] as const);
export type JcActionKind = (typeof JC_ACTION_KINDS)[number];

export type JcRiskClass = "low" | "medium" | "critical";

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
}

type ToolRow = Omit<JcToolContract, "name" | "argsSchema">;

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
  )
};

function buildManifest(): ReadonlyMap<JcToolName, JcToolContract> {
  const entries = new Map<JcToolName, JcToolContract>();
  for (const name of JC_TOOL_NAMES) {
    const source = TOOL_ROWS[name];
    entries.set(
      name,
      Object.freeze({
        name,
        argsSchema: JC_TOOL_ARGUMENT_SCHEMAS[name],
        ...source,
        // Do not expose TOOL_ROWS' mutable array through the public contract.
        // Policy consumers retain these objects for the process lifetime, so
        // nested policy values must be immutable too.
        scopes: Object.freeze([...source.scopes])
      })
    );
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
