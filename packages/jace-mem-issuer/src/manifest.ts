import { z } from "zod";

/**
 * Canonical Jace-Mem tool contract for ACS-issued `acs.jm.v1` capabilities
 * (docs/protocol/acs-jm-v1-capability-contract.md).
 *
 * This is the ONE ACS-side definition of which Jace-Mem tools exist, the
 * scope each requires, whether a human approval is required before ACS signs,
 * and the strict argument schema ACS validates before signing. Jace-Mem keeps
 * its own copy of the table (jace-mem src/acs.ts TOOL_POLICY and the MCP
 * inputSchemas in src/mcp.ts); the shared contract vectors fail when the two
 * disagree.
 *
 * Nothing here is an authorization decision by itself. ACS decides through
 * work items, policy, approvals and leases; Jace-Mem only enforces the signed
 * result.
 */

export const JM_CAPABILITY_VERSION = "acs.jm.v1" as const;
export const JM_AUDIENCE = "jace-mem" as const;
export const JM_INVOCATION_DOMAIN = "acs:jace-mem-invocation:v1";

/** The complete acs.jm.v1 scope vocabulary. Read, write, delete and share are distinct. */
export const JM_SCOPES = Object.freeze(["memory.read", "memory.write", "memory.delete", "memory.share"] as const);
export type JmScope = (typeof JM_SCOPES)[number];

/** Policy-gate action kinds for Jace-Mem tools (packages/policy-gate/src/rules.ts). */
export const JM_ACTION_KINDS = Object.freeze([
  "jm.memory.read",
  "jm.memory.write",
  "jm.memory.delete",
  "jm.memory.share"
] as const);
export type JmActionKind = (typeof JM_ACTION_KINDS)[number];

/** Same values Jace-Mem's store accepts (jace-mem src/store.ts KINDS / STATUSES). */
export const JM_OBSERVATION_KINDS = Object.freeze([
  "FACT",
  "DECISION",
  "PREFERENCE",
  "TASK",
  "CLAIM",
  "EVIDENCE",
  "OBSERVATION",
  "SUMMARY",
  "INSTRUCTION"
] as const);
export const JM_OBSERVATION_STATUSES = Object.freeze(["CONFIRMED", "CLAIMED", "INFERRED", "UNKNOWN"] as const);

/**
 * Upper bounds ACS applies before signing. They equal Jace-Mem's own limits
 * (jace-mem src/store.ts, enforced again at execution time), so ACS neither
 * signs an invocation Jace-Mem must reject for size nor refuses one it accepts.
 */
export const JM_ARGUMENT_LIMITS = Object.freeze({
  idChars: 128,
  textBytes: 65_536,
  sourceBytes: 1_024,
  commitBytes: 256,
  verificationBytes: 8_192,
  queryChars: 1_024,
  derivedFrom: 100,
  searchLimit: 100,
  searchOffset: 100_000
});

const id = z.string().min(1).max(JM_ARGUMENT_LIMITS.idChars);
const boundedBytes = (max: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, { message: `must be at most ${max} bytes` });
const query = z.string().min(1).max(JM_ARGUMENT_LIMITS.queryChars);
const commit = boundedBytes(JM_ARGUMENT_LIMITS.commitBytes);
const limit = z.number().int().min(1).max(JM_ARGUMENT_LIMITS.searchLimit);
const offset = z.number().int().min(0).max(JM_ARGUMENT_LIMITS.searchOffset);
/** Agent names follow Jace-Mem's identity rules (see validateJaceMemSubject). */
const agentName = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value) && Buffer.byteLength(value) <= 256, {
    message: "is not a valid agent name"
  });

export const JM_TOOL_NAMES = Object.freeze([
  "session_start",
  "session_end",
  "session_delete",
  "memory_capture",
  "memory_search",
  "memory_get",
  "memory_delete",
  "memory_retain_since",
  "memory_status",
  "memory_search_shared"
] as const);
export type JmToolName = (typeof JM_TOOL_NAMES)[number];

/** Strict schemas: exact keys, no defaults, no coercion. Mirrors Jace-Mem's MCP inputSchemas. */
export const JM_TOOL_ARGUMENT_SCHEMAS: Readonly<Record<JmToolName, z.ZodType>> = Object.freeze({
  session_start: z.strictObject({}),
  session_end: z.strictObject({ session: id }),
  session_delete: z.strictObject({ session: id }),
  memory_capture: z.strictObject({
    session: id,
    text: boundedBytes(JM_ARGUMENT_LIMITS.textBytes).refine((value) => value.trim().length > 0, {
      message: "must not be blank"
    }),
    kind: z.enum(JM_OBSERVATION_KINDS),
    status: z.enum(JM_OBSERVATION_STATUSES),
    source: boundedBytes(JM_ARGUMENT_LIMITS.sourceBytes).refine((value) => value.trim().length > 0, {
      message: "must not be blank"
    }),
    commit: commit.optional(),
    verification: boundedBytes(JM_ARGUMENT_LIMITS.verificationBytes).optional(),
    supersedes: id.optional(),
    derivedFrom: z.array(id).min(1).max(JM_ARGUMENT_LIMITS.derivedFrom).optional()
  }),
  memory_search: z.strictObject({
    query,
    currentCommit: commit.optional(),
    limit: limit.optional(),
    offset: offset.optional()
  }),
  memory_get: z.strictObject({ id, currentCommit: commit.optional() }),
  memory_delete: z.strictObject({ id }),
  memory_retain_since: z.strictObject({
    cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u, "must be an ISO UTC timestamp")
  }),
  memory_status: z.strictObject({}),
  memory_search_shared: z.strictObject({
    targetAgent: agentName,
    query,
    currentCommit: commit.optional(),
    limit: limit.optional(),
    offset: offset.optional()
  })
});

export interface JmToolContract {
  readonly name: JmToolName;
  readonly scopes: readonly JmScope[];
  /** ACS signs only against a consumed approval granted by a human other than the requester. */
  readonly requiresApproval: boolean;
  readonly actionKind: JmActionKind;
  readonly risk: "low" | "medium" | "high";
}

const contract = (
  name: JmToolName,
  scope: JmScope,
  actionKind: JmActionKind,
  requiresApproval: boolean,
  risk: JmToolContract["risk"]
): JmToolContract => Object.freeze({ name, scopes: Object.freeze([scope]), requiresApproval, actionKind, risk });

const CONTRACTS: Readonly<Record<JmToolName, JmToolContract>> = Object.freeze({
  session_start: contract("session_start", "memory.write", "jm.memory.write", false, "low"),
  session_end: contract("session_end", "memory.write", "jm.memory.write", false, "low"),
  memory_capture: contract("memory_capture", "memory.write", "jm.memory.write", false, "low"),
  memory_search: contract("memory_search", "memory.read", "jm.memory.read", false, "low"),
  memory_get: contract("memory_get", "memory.read", "jm.memory.read", false, "low"),
  memory_status: contract("memory_status", "memory.read", "jm.memory.read", false, "low"),
  memory_delete: contract("memory_delete", "memory.delete", "jm.memory.delete", true, "medium"),
  session_delete: contract("session_delete", "memory.delete", "jm.memory.delete", true, "medium"),
  memory_retain_since: contract("memory_retain_since", "memory.delete", "jm.memory.delete", true, "high"),
  memory_search_shared: contract("memory_search_shared", "memory.share", "jm.memory.share", true, "medium")
});

export function jmToolContract(toolName: string): JmToolContract | undefined {
  return Object.hasOwn(CONTRACTS, toolName) ? CONTRACTS[toolName as JmToolName] : undefined;
}

export function jmToolContracts(): JmToolContract[] {
  return JM_TOOL_NAMES.map((name) => CONTRACTS[name]);
}
