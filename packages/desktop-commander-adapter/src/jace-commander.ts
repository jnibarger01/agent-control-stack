import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { ControlStackError, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import {
  JC_TOOL_ARGUMENT_SCHEMAS,
  jcToolContract,
  jcToolNames,
  type JcActionKind,
  type JcScope
} from "@agent-control-stack/jc-tool-manifest";
import type { z } from "zod";

/**
 * acs.jc.v1 — ACS-issued capabilities for the Jace Commander MCP server
 * (jnibarger01/desktop-commander src/jace-commander, docs/jace-commander.md).
 *
 * Same envelope, strict canonicalization, Ed25519 signature, <=30 s TTL and
 * single-use nonce rules as acs.dc.v1 (docs/protocol/acs-jc-v1-capability-contract.md),
 * but a separate version, audience, scope vocabulary and invocation domain so
 * neither contract's capabilities verify under the other.
 *
 * `privileged_exec` is the only approval-bound tool. ACS signs it only for a
 * consumed, human-granted approval bound to the exact argv.
 */

export const JACE_COMMANDER_CAPABILITY_VERSION = "acs.jc.v1" as const;
export const JACE_COMMANDER_AUDIENCE = "jace-commander" as const;
export const JACE_COMMANDER_INVOCATION_DOMAIN = "acs:jace-commander-invocation:v1";
export const JACE_COMMANDER_PRIVILEGED_TOOL = "privileged_exec" as const;
/** Policy action kind for privileged_exec; policy-gate always requires human approval for it. */
export const PRIVILEGED_EXEC_ACTION_KIND = "privileged.exec" as const;

// Scope, action-kind, argument-schema and policy data now live in the single
// canonical @agent-control-stack/jc-tool-manifest package (imported above).
// These type aliases and the policy lookup below keep this module's existing
// exported names and shapes unchanged for callers.
export type JaceCommanderScope = JcScope;
export type JaceCommanderActionKind = JcActionKind;

export interface JaceCommanderToolPolicy {
  readonly name: string;
  readonly scopes: readonly JaceCommanderScope[];
  readonly requiresApproval: boolean;
  readonly actionKind: JaceCommanderActionKind;
  readonly risk: "low" | "medium" | "critical";
}

const ARGUMENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = JC_TOOL_ARGUMENT_SCHEMAS;

export function jaceCommanderToolPolicy(toolName: string): JaceCommanderToolPolicy | undefined {
  const entry = jcToolContract(toolName);
  if (!entry) return undefined;
  return Object.freeze({
    name: entry.name,
    scopes: entry.scopes,
    requiresApproval: entry.requiresApproval,
    actionKind: entry.actionKind,
    risk: entry.risk
  });
}

export function jaceCommanderToolNames(): string[] {
  return jcToolNames();
}

export interface JaceCommanderInvocation {
  readonly toolName: string;
  /** The exact delivered arguments (validated, never rewritten). */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
  readonly policy: JaceCommanderToolPolicy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jaceCommanderInvocationHash(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${JACE_COMMANDER_INVOCATION_DOMAIN}\n${strictCanonicalJsonV1({ toolName, arguments: args })}`, "utf8")
    .digest("hex");
}

/**
 * Validates the exact delivered arguments. No defaults, coercion or path
 * rewriting: the verifier compares the signed `normalizedArguments` against
 * what the MCP client actually delivers, so any rewrite would fail closed.
 */
export function validateJaceCommanderInvocation(toolName: string, rawArguments: unknown): JaceCommanderInvocation {
  const toolPolicy = jaceCommanderToolPolicy(toolName);
  const schema = ARGUMENT_SCHEMAS[toolName];
  if (!toolPolicy || !schema) {
    throw new ControlStackError("jace_commander_tool_not_allowlisted", `unknown Jace Commander tool: ${toolName}`);
  }
  if (!isPlainObject(rawArguments)) {
    throw new ControlStackError("jace_commander_argument_invalid", "tool arguments must be a plain object");
  }
  const args = Object.fromEntries(Object.entries(rawArguments).filter(([, value]) => value !== undefined));
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ControlStackError(
      "jace_commander_argument_invalid",
      `${toolName}: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid arguments"}`
    );
  }
  let canonicalArgs: Record<string, unknown>;
  try {
    // Round-trip through strict canonical JSON: rejects non-JSON values and
    // freezes a detached copy of exactly what will be signed.
    canonicalArgs = JSON.parse(strictCanonicalJsonV1(args)) as Record<string, unknown>;
  } catch {
    throw new ControlStackError("jace_commander_argument_invalid", "tool arguments are not strict JSON");
  }
  return Object.freeze({
    toolName,
    arguments: Object.freeze(canonicalArgs),
    invocationHash: jaceCommanderInvocationHash(toolName, canonicalArgs),
    policy: toolPolicy
  });
}

/** Human-readable approval summary shown to the approver; never contains stdin content. */
export function jaceCommanderApprovalSummary(invocation: JaceCommanderInvocation): Record<string, unknown> {
  if (invocation.toolName !== JACE_COMMANDER_PRIVILEGED_TOOL) {
    return { tool: invocation.toolName, invocationHash: invocation.invocationHash };
  }
  const args = invocation.arguments as { argv: string[]; cwd?: string; timeoutMs?: number; stdin?: string };
  return {
    tool: invocation.toolName,
    runAs: "root",
    argv: args.argv,
    cwd: args.cwd ?? "/",
    timeoutMs: args.timeoutMs ?? 60_000,
    stdinBytes: args.stdin === undefined ? 0 : Buffer.byteLength(args.stdin, "utf8"),
    invocationHash: invocation.invocationHash
  };
}

// --- execution authorization --------------------------------------------------

const AUTHORIZATION_BRAND = Symbol("acs.jace-commander.execution-authorization");

export interface JaceCommanderExecutionAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly planHash: string;
  readonly inputHash: string;
  readonly fencingEpoch: number;
  readonly actionHash: string;
  readonly invocation: JaceCommanderInvocation;
  readonly approvalId?: string;
  readonly approvalActionHash?: string;
}

export interface AuthorizeJaceCommanderInput {
  claimed: ClaimedWorkItem;
  trustedWorkItem: Pick<WorkItem, "id" | "status" | "requester" | "intent" | "target" | "requestedActions" | "risk">;
  lease: AttemptLease;
  workerId: string;
  invocation: JaceCommanderInvocation;
  now?: Date;
}

/** Re-checks work-item, lease, fencing, action and invocation binding immediately before issuance. */
export function authorizeJaceCommanderExecution(
  input: AuthorizeJaceCommanderInput
): JaceCommanderExecutionAuthorization {
  const now = input.now ?? new Date();
  const { claimed, trustedWorkItem, lease, workerId, invocation } = input;
  const fail = (code: string, message: string): never => {
    throw new ControlStackError(code, message);
  };
  if (trustedWorkItem.status !== "running") fail("jace_commander_work_item_not_executable", "work item is not running");
  if (claimed.id !== trustedWorkItem.id) fail("jace_commander_work_item_mismatch", "claimed work item mismatch");
  if (claimed.workerId !== workerId || lease.workerId !== workerId) {
    fail("jace_commander_lease_worker_mismatch", "lease is not held by this worker");
  }
  if (lease.workItemId !== trustedWorkItem.id)
    fail("jace_commander_lease_work_item_mismatch", "lease work item mismatch");
  if (claimed.attemptId === undefined || lease.attemptId !== claimed.attemptId) {
    fail("jace_commander_lease_attempt_mismatch", "lease attempt mismatch");
  }
  if (lease.status !== "active") fail("jace_commander_lease_inactive", `attempt lease is ${lease.status}`);
  const leaseExpiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= now.getTime())
    fail("jace_commander_lease_expired", "lease expired");
  if (claimed.fencingEpoch === undefined || lease.fencingEpoch !== claimed.fencingEpoch) {
    fail("jace_commander_lease_fencing_mismatch", "lease fencing epoch mismatch");
  }
  if (claimed.planHash === undefined || claimed.inputHash === undefined || lease.planHash !== claimed.planHash) {
    fail("jace_commander_plan_hash_mismatch", "lease plan hash mismatch");
  }
  const recomputedActionHash = executionActionHash(trustedWorkItem);
  if (recomputedActionHash !== claimed.actionHash) {
    fail("jace_commander_action_hash_changed", "work item action hash changed since claim");
  }
  const actions = trustedWorkItem.requestedActions ?? [];
  const params = (actions[0]?.params ?? {}) as Record<string, unknown>;
  if (
    actions.length !== 1 ||
    actions[0]?.kind !== invocation.policy.actionKind ||
    params.tool !== invocation.toolName ||
    params.invocationHash !== invocation.invocationHash
  ) {
    fail("jace_commander_invocation_binding_mismatch", "invocation does not match the trusted work-item binding");
  }
  if (invocation.policy.requiresApproval && lease.approvalId === undefined) {
    fail("jace_commander_approval_missing", `${invocation.toolName} requires a lease-bound approval`);
  }
  if (!invocation.policy.requiresApproval && lease.approvalId !== undefined) {
    fail("jace_commander_approval_unexpected", `${invocation.toolName} must not carry an approval`);
  }
  return Object.freeze({
    [AUTHORIZATION_BRAND]: true as const,
    workItemId: trustedWorkItem.id,
    attemptId: claimed.attemptId!,
    leaseId: claimed.leaseId,
    workerId,
    planHash: claimed.planHash!,
    inputHash: claimed.inputHash!,
    fencingEpoch: claimed.fencingEpoch!,
    actionHash: recomputedActionHash,
    invocation,
    ...(lease.approvalId !== undefined ? { approvalId: lease.approvalId } : {})
  });
}

// --- payload + signing ---------------------------------------------------------

export interface JaceCommanderCapabilityPayload {
  readonly version: typeof JACE_COMMANDER_CAPABILITY_VERSION;
  readonly issuer: "acs";
  readonly audience: typeof JACE_COMMANDER_AUDIENCE;
  readonly runtimeId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly toolName: string;
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly invocationHash: string;
  readonly actionHash: string;
  readonly requestHash: string;
  readonly planHash: string;
  readonly scopes: readonly string[];
  readonly approvalId?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface JaceCommanderCapability {
  readonly payload: JaceCommanderCapabilityPayload;
  readonly signature: string;
  readonly keyId: string;
}

export interface JaceCommanderSigningConfig {
  readonly runtimeId: string;
  readonly keyId: string;
  /** Base64url PKCS#8 DER Ed25519. Must differ from the acs.dc.v1 key. */
  readonly privateKey: string;
  readonly ttlMs?: number;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

export function prepareJaceCommanderCapability(
  authorization: JaceCommanderExecutionAuthorization,
  config: JaceCommanderSigningConfig,
  now = new Date()
): JaceCommanderCapabilityPayload {
  if (!ID_PATTERN.test(config.runtimeId) || !KEY_ID_PATTERN.test(config.keyId)) {
    throw new ControlStackError("jace_commander_capability_invalid", "runtimeId or keyId is invalid");
  }
  // One second inside the 30 s protocol ceiling (see acs.dc.v1 prepare rationale).
  const ttlMs = config.ttlMs ?? 29_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) {
    throw new ControlStackError("jace_commander_capability_invalid", "capability TTL must be between 1 and 30000ms");
  }
  const { invocation } = authorization;
  if (invocation.policy.requiresApproval !== (authorization.approvalId !== undefined)) {
    throw new ControlStackError("jace_commander_capability_invalid", "approval presence does not match tool policy");
  }
  const actionHash =
    authorization.approvalId !== undefined && authorization.approvalActionHash !== undefined
      ? authorization.approvalActionHash
      : authorization.actionHash;
  const requestHash = executionPlanApprovalRequestHash({
    workItemId: authorization.workItemId,
    planHash: authorization.planHash,
    actionHash
  });
  const issuedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString();
  return Object.freeze({
    version: JACE_COMMANDER_CAPABILITY_VERSION,
    issuer: "acs",
    audience: JACE_COMMANDER_AUDIENCE,
    runtimeId: config.runtimeId,
    workItemId: authorization.workItemId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    leaseEpoch: authorization.fencingEpoch,
    toolName: invocation.toolName,
    normalizedArguments: invocation.arguments,
    invocationHash: invocation.invocationHash,
    actionHash,
    requestHash,
    planHash: authorization.planHash,
    scopes: [...invocation.policy.scopes],
    ...(authorization.approvalId !== undefined ? { approvalId: authorization.approvalId } : {}),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    nonce: randomBytes(32).toString("base64url")
  });
}

function signingKey(config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">) {
  if (!KEY_ID_PATTERN.test(config.keyId)) {
    throw new ControlStackError("jace_commander_capability_invalid", "keyId is invalid");
  }
  try {
    const key = createPrivateKey({ key: Buffer.from(config.privateKey, "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new ControlStackError("jace_commander_capability_invalid", "signing key is not a valid Ed25519 PKCS#8 key");
  }
}

export function validateJaceCommanderSigningConfig(
  config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">
): void {
  void signingKey(config);
}

/** Signs only after the caller's durable issuance record commits. */
export function signPreparedJaceCommanderCapability(
  payload: JaceCommanderCapabilityPayload,
  config: Pick<JaceCommanderSigningConfig, "keyId" | "privateKey">
): JaceCommanderCapability {
  const signature = sign(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), signingKey(config));
  return Object.freeze({ payload, signature: signature.toString("base64url"), keyId: config.keyId });
}

export function jaceCommanderNonceHash(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) {
    throw new ControlStackError("jace_commander_capability_invalid", "nonce is invalid");
  }
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}

/** Reads acs.jc.v1 signing config from env; absent config disables the route (fail closed). */
export function jaceCommanderSigningConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): JaceCommanderSigningConfig | undefined {
  const privateKey = env.ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY;
  const keyId = env.ACS_JACE_COMMANDER_CAPABILITY_KEY_ID;
  const runtimeId = env.ACS_JACE_COMMANDER_RUNTIME_ID;
  if (!privateKey && !keyId && !runtimeId) return undefined;
  if (!privateKey || !keyId || !runtimeId) {
    throw new ControlStackError(
      "jace_commander_capability_config_incomplete",
      "ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY, ACS_JACE_COMMANDER_CAPABILITY_KEY_ID and ACS_JACE_COMMANDER_RUNTIME_ID must be set together"
    );
  }
  const config = { privateKey, keyId, runtimeId };
  validateJaceCommanderSigningConfig(config);
  if (!ID_PATTERN.test(runtimeId))
    throw new ControlStackError("jace_commander_capability_invalid", "runtimeId is invalid");
  return config;
}
